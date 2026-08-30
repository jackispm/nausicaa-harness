import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelPort, ModelResponse, UserImage } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { computeEventContentHash, JsonlLedger } from "../../src/ledger/index.js";
import {
  listWorkspaceRuns,
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import {
  MESSAGE_MEDIA_TYPE,
  projectSessionTranscript,
} from "../../src/runtime/session-artifacts.js";
import type { RuntimeFukaiCompactionFactory } from "../../src/runtime/fukai-compaction-runtime.js";
import { FileContentAddressedStore } from "../../src/store/index.js";
import { WorkspaceCommandSandbox } from "../../src/tools/index.js";
import { FileProcessJobRegistry } from "../../src/tools/process-jobs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("SessionController", () => {
  it("projects assistant tool-call presence from its durable message", async () => {
    const root = await temporaryRoot();
    const runId = "assistant-tool-call-projection";
    const store = await FileContentAddressedStore.open(join(root, "store"));
    const messageRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "I need a tool",
      toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "README.md" } }],
      createdAt: "2026-08-30T00:00:00.000Z",
    }), MESSAGE_MEDIA_TYPE);
    const ledger = await JsonlLedger.open(join(root, "ledger.jsonl"));
    await ledger.append({
      runId,
      turnId: "turn-1",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef },
      correlationId: "turn:turn-1",
      idempotencyKey: "assistant:tool-call",
      visibility: "lane",
    });

    const transcript = await projectSessionTranscript(
      store,
      await ledger.read({ runId }),
      runId,
    );

    expect(transcript).toEqual([{
      role: "assistant",
      content: "I need a tool",
      hasToolCalls: true,
      turnId: "turn-1",
    }]);
    await ledger.close();
  });

  it("lists workspace Runs newest first with projected status and Goal", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    let now = new Date("2026-08-30T10:00:00.000Z");
    const clock = { now: () => new Date(now) };

    const older = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: new ScriptedModel([response("older answer")]), createRunId: () => "older-run", clock });
    await older.reviseGoal("Inspect the older Run");
    await older.close();
    const olderLedger = await JsonlLedger.open(join(dataDir, "runs", "older-run", "ledger.jsonl"));
    await olderLedger.append({
      runId: "older-run",
      laneId: "main",
      type: "goal.revised",
      payload: {
        goal: {
          version: 2,
          statement: "Inspect the older Run",
          successCriteria: [],
          hardConstraints: [],
        },
      },
      correlationId: "run:older-run",
      idempotencyKey: "test:older:updated",
      visibility: "run",
      occurredAt: now.toISOString(),
    });
    await olderLedger.close();

    now = new Date("2026-08-30T10:05:00.000Z");
    const newer = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: new ScriptedModel([response("newer answer")]), createRunId: () => "newer-run", clock });
    await newer.reviseGoal("Inspect the newer Run");
    await newer.close();
    const newerLedger = await JsonlLedger.open(join(dataDir, "runs", "newer-run", "ledger.jsonl"));
    await newerLedger.append({
      runId: "newer-run",
      laneId: "main",
      type: "goal.revised",
      payload: {
        goal: {
          version: 2,
          statement: "Inspect the newer Run",
          successCriteria: [],
          hardConstraints: [],
        },
      },
      correlationId: "run:newer-run",
      idempotencyKey: "test:newer:updated",
      visibility: "run",
      occurredAt: now.toISOString(),
    });
    await newerLedger.close();

    const damagedDir = join(dataDir, "runs", "damaged-run");
    await mkdir(damagedDir, { recursive: true });
    await writeFile(join(damagedDir, "ledger.jsonl"), "not-json\n", "utf8");

    const runs = await listWorkspaceRuns(dataDir, root);
    expect(runs.map((run) => run.runId)).toEqual(["newer-run", "older-run"]);
    expect(runs[0]).toMatchObject({
      runId: "newer-run",
      goal: "Inspect the newer Run",
      status: "ready",
      createdAt: "2026-08-30T10:05:00.000Z",
      updatedAt: "2026-08-30T10:05:00.000Z",
    });
    expect(await listWorkspaceRuns(join(root, "missing-state"), root)).toEqual([]);
  });

  it("uses a per-Run durable process-job registry when configured", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const runId = "durable-process-jobs";
    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      allowShell: true,
      processJobRegistryDir: dataDir,
      policy: {
        maxMainStepsPerActivation: 2,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: new ScriptedModel([
        {
          ...response("started"),
          stopReason: "toolUse",
          toolCalls: [{
            id: "durable-process-start",
            name: "process_start",
            arguments: { command: "printf durable" },
          }],
        },
        response("done"),
      ]),
      createRunId: () => runId,
    });

    await session.submit({ inputId: "durable-process-input", text: "Start the process" });
    await session.waitForIdle();
    await session.close();

    const registry = await FileProcessJobRegistry.open(
      join(dataDir, "runs", runId, "process-jobs.json"),
    );
    const entries = await registry.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.snapshot).toMatchObject({
      runId,
      state: "succeeded",
    });
  });

  it("does not construct an interactive compaction runtime while disabled", async () => {
    const root = await temporaryRoot();
    let factoryCalls = 0;
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("done")]),
      createRunId: () => "disabled-session-fukai",
      createCompactionRuntime: () => {
        factoryCalls += 1;
        throw new Error("disabled factory must not run");
      },
    });

    await session.submit({ inputId: "disabled-input", text: "Inspect" });
    await session.waitForIdle();
    expect(factoryCalls).toBe(0);
    await session.close();
  });

  it("prepares Fukai once per Turn and excludes the current Turn input", async () => {
    const root = await temporaryRoot();
    const sourceCounts: number[] = [];
    const policyVersions = new Set<string>();
    let factoryCalls = 0;
    let selectCalls = 0;
    const factory: RuntimeFukaiCompactionFactory = () => {
      factoryCalls += 1;
      let prepared = false;
      return {
        async prepare(request) {
          expect(prepared).toBe(false);
          prepared = true;
          sourceCounts.push(request.conversationRefs.length);
          policyVersions.add(request.policyVersion);
        },
        async select(request) {
          expect(prepared).toBe(true);
          selectCalls += 1;
          policyVersions.add(request.policyVersion);
          return undefined;
        },
      };
    };
    const model = new ScriptedModel([
      response("first answer"),
      {
        ...response("inspect once more"),
        stopReason: "toolUse",
        toolCalls: [{ id: "session-fukai-noop", name: "noop", arguments: {} }],
      },
      response("second answer"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      fukaiCompaction: enabledFukaiPolicy(),
      policy: {
        maxMainStepsPerActivation: 2,
        maxModelTokens: 20_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: model,
      tools: [noopTool],
      createRunId: () => "two-turn-fukai-runtime",
      createCompactionRuntime: factory,
    });

    await session.submit({ inputId: "fukai-turn-1", text: "First task" });
    await session.waitForIdle();
    await session.submit({ inputId: "fukai-turn-2", text: "Second task" });
    await session.waitForIdle();

    expect(factoryCalls).toBe(2);
    expect(sourceCounts).toEqual([0, 2]);
    expect(selectCalls).toBe(3);
    expect([...policyVersions]).toHaveLength(1);
    expect([...policyVersions][0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    await session.close();
  });

  it("publishes compaction lifecycle events and includes their usage in snapshots", async () => {
    const root = await temporaryRoot();
    const mainResponses = [
      response("x".repeat(5_000)),
      response("second answer"),
      response("third answer"),
    ];
    const model: ModelPort = {
      // Keep enough response headroom while making the first large answer
      // cross the model-window pressure threshold on a later Turn.
      capabilities: () => ({ imageInput: false, contextWindowTokens: 4_000 }),
      async complete(request) {
        if (request.sessionId.startsWith("fukai-compaction:")) {
          return response(JSON.stringify({
            decisions: ["Keep the first answer as established context"],
            verifiedResults: ["The first Turn completed"],
            openQuestions: [],
          }));
        }
        const next = mainResponses.shift();
        if (next === undefined) throw new Error("Unexpected Main request");
        return next;
      },
    };
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      maxOutputTokens: 100,
      fukaiCompaction: {
        ...enabledFukaiPolicy(),
        maxInputTokens: 12_000,
        retainRatio: 0.001,
      },
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "session-fukai-live-events",
    });
    const observed: SessionRuntimeEvent[] = [];
    session.subscribe((event) => observed.push(event));

    await session.submit({ inputId: "live-fukai-1", text: "First task" });
    await session.waitForIdle();
    await session.submit({ inputId: "live-fukai-2", text: "Second task" });
    await session.waitForIdle();
    await session.submit({ inputId: "live-fukai-3", text: "Third task" });
    await session.waitForIdle();

    const types = durableEvents(observed).map((event) => event.type);
    expect(types).toContain("fukai.compaction.requested");
    expect(types).toContain("fukai.compaction.completed");
    expect(types).toContain("fukai.compaction.committed");
    expect(session.snapshot().usage).toMatchObject({ input: 40, output: 8 });
    await session.close();
  });

  it("persists explicit Fukai settings in an interactive Run", async () => {
    const root = await temporaryRoot();
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
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      fukaiCompaction,
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("done")]),
      createRunId: () => "session-fukai-config",
    });

    await session.submit({ inputId: "fukai-input", text: "Inspect the workspace" });
    await session.waitForIdle();
    await session.close();

    const ledger = await JsonlLedger.open(join(
      root,
      "state",
      "runs",
      "session-fukai-config",
      "ledger.jsonl",
    ));
    const events = await ledger.read({ runId: "session-fukai-config" });
    const created = events.find((event) => event.type === "run.created");
    expect(created?.type).toBe("run.created");
    if (created?.type !== "run.created") throw new Error("Missing run.created");
    expect(created.payload.policy.fukaiCompaction).toEqual(fukaiCompaction);
    await ledger.close();

    const reopened = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId: "session-fukai-config",
      fukaiCompaction,
    }, {
      mainModel: new ScriptedModel([]),
    });
    await reopened.close();

    await expect(SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId: "session-fukai-config",
      fukaiCompaction: {
        ...fukaiCompaction,
        minimumGainTokens: fukaiCompaction.minimumGainTokens + 1,
      },
    }, {
      mainModel: new ScriptedModel([]),
    })).rejects.toThrow("Cannot change fukaiCompaction while resuming a Run");
  });

  it("runs two Turns in one persistent Run with shared conversation context", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("first answer"), response("second answer")]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "two-turn-run");
    session.subscribe((event) => events.push(event));

    await session.submit({ inputId: "input-1", text: "Inspect the project" });
    await session.waitForIdle();
    const runId = session.snapshot().runId;
    await session.submit({ inputId: "input-2", text: "Now summarize it" });
    await session.waitForIdle();

    expect(session.snapshot()).toMatchObject({ runId, status: "idle" });
    expect(model.requests).toHaveLength(2);
    expect(new Set(model.requests.map((request) => request.sessionId)))
      .toEqual(new Set(["two-turn-run:main"]));
    expect(model.requests[1]?.messages.map((message) => message.content)).toEqual([
      "Inspect the project",
      "first answer",
      "Now summarize it",
    ]);
    await expect(session.transcript()).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "Inspect the project" }),
      expect.objectContaining({ role: "assistant", content: "first answer" }),
      expect.objectContaining({ role: "user", content: "Now summarize it" }),
      expect.objectContaining({ role: "assistant", content: "second answer" }),
    ]);
    const durable = durableEvents(events);
    const turns = durable.filter((event) => event.type === "turn.started");
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((event) => event.payload.turnId)).size).toBe(2);
    expect(durable.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    expect(durable.filter((event) => event.type === "run.completed")).toHaveLength(0);
    expect(mainLaneStatuses(durable)).toEqual([
        "running",
        "ready",
        "running",
        "ready",
      ]);
    expect(durable
      .filter((event) => event.type === "navigation.updated")
      .map((event) => event.payload.delta.activeObjective)).toEqual([
        "Inspect the project",
        "Now summarize it",
      ]);
    expect(durable.find((event) => event.type === "run.created")?.payload.goal.statement)
      .toBe("Assist the user with tasks in the current workspace");
    expect(model.requests[1]?.systemPrompt)
      .toContain("Goal v1: Assist the user with tasks in the current workspace");
    expect(durable.filter((event) => event.type === "goal.revised")).toHaveLength(0);
    const prefixHashes = durable
      .filter((event) => event.type === "model.requested")
      .map((event) => event.payload.prefixHash);
    expect(prefixHashes).toHaveLength(2);
    expect(prefixHashes.every((hash) => hash !== undefined)).toBe(true);
    expect(new Set(prefixHashes).size).toBe(1);
    await session.close();
  });

  it("projects the latest durable Main context estimate against the model window", async () => {
    const root = await temporaryRoot();
    const model: ModelPort = {
      capabilities: () => ({ imageInput: false, contextWindowTokens: 128_000 }),
      async complete() {
        return response("context measured");
      },
    };
    const events: SessionRuntimeEvent[] = [];
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "openrouter:metered",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "context-meter-run",
    });
    session.subscribe((event) => events.push(event));

    expect(session.snapshot()).toMatchObject({
      mainContextTokens: null,
      mainContextWindowTokens: 128_000,
    });
    await session.submit({ inputId: "context-meter-input", text: "Measure this request" });
    await session.waitForIdle();

    const requested = durableEvents(events).findLast((event) => (
      event.type === "model.requested" && event.laneId === "main"
    ));
    expect(requested?.type).toBe("model.requested");
    if (requested?.type !== "model.requested") throw new Error("Missing Main request");
    expect(requested.payload.estimatedInputTokens).toBeGreaterThan(0);
    expect(session.snapshot()).toMatchObject({
      mainContextTokens: requested.payload.estimatedInputTokens,
      mainContextWindowTokens: 128_000,
    });
    const overview = session.contextOverview();
    expect(overview.currentContext).toEqual({
      tokens: requested.payload.estimatedInputTokens,
      contextWindowTokens: 128_000,
      percent: (requested.payload.estimatedInputTokens! / 128_000) * 100,
    });
    expect(overview.usage).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(overview.lanes).toEqual([{
      laneId: "main",
      usage: overview.usage,
    }]);
    expect(overview.currentContext.tokens).not.toBe(overview.usage.input);
    await session.selectModel("openrouter:other");
    expect(session.snapshot()).toMatchObject({
      model: "openrouter:other",
      mainContextTokens: null,
      mainContextWindowTokens: 128_000,
    });
    expect(session.contextOverview().currentContext).toEqual({
      tokens: null,
      contextWindowTokens: 128_000,
      percent: null,
    });
    await session.close();
  });

  it("switches future Turns between read-only, workspace, and full-access capabilities", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      response("workspace"),
      response("full"),
      response("read only"),
    ]);
    const workspaceCommandSandbox = new WorkspaceCommandSandbox({
      platform: "darwin",
      seatbeltExecutable: "/usr/bin/true",
      probe: () => true,
    });
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "permission-profile-run",
      workspaceCommandSandbox,
    });

    expect(session.snapshot()).toMatchObject({
      permissionProfile: "read-only",
      collaborationMode: "default",
      workspaceBashAvailability: {
        available: true,
        backend: "macos-seatbelt",
      },
    });
    await expect(session.selectPermissionProfile("workspace")).resolves.toMatchObject({
      previousProfile: "read-only",
      profile: "workspace",
      changed: true,
    });
    await session.submit({ inputId: "workspace-input", text: "Edit the workspace" });
    await session.waitForIdle();
    const workspaceTools = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(workspaceTools).toContain("write_file");
    expect(workspaceTools).toContain("edit");
    expect(workspaceTools).toContain("bash");
    expect(workspaceTools).not.toContain("process_start");
    expect(workspaceTools).not.toContain("web_fetch");

    await session.selectPermissionProfile("full-access");
    await session.submit({ inputId: "full-input", text: "Use full capabilities" });
    await session.waitForIdle();
    const fullTools = model.requests[1]?.tools.map((tool) => tool.name) ?? [];
    expect(fullTools).toContain("bash");
    expect(fullTools).toContain("web_fetch");
    expect(fullTools).toContain("process_start");

    await session.selectPermissionProfile("read-only");
    await session.submit({ inputId: "read-input", text: "Only inspect" });
    await session.waitForIdle();
    const readTools = model.requests[2]?.tools.map((tool) => tool.name) ?? [];
    expect(readTools).toContain("read_file");
    expect(readTools).not.toContain("write_file");
    expect(readTools).not.toContain("bash");
    expect(readTools).not.toContain("web_fetch");
    await session.close();
  });

  it("reports why workspace Bash is unavailable without widening the boundary", async () => {
    const root = await temporaryRoot();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      allowWrite: true,
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([]),
      workspaceCommandSandbox: new WorkspaceCommandSandbox({ platform: "win32" }),
    });

    expect(session.snapshot()).toMatchObject({
      permissionProfile: "workspace",
      allowWrite: true,
      allowShell: false,
      allowNetwork: false,
      workspaceBashAvailability: {
        available: false,
        reason: "Workspace Bash has no OS sandbox backend for win32",
      },
    });
    await session.close();
  });

  it("makes Plan mode a read-only runtime boundary rather than a visual label", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("plan"), response("implementation")]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
      collaborationMode: "plan",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "plan-mode-run",
    });

    await session.submit({ inputId: "plan-input", text: "Plan the change" });
    await session.waitForIdle();
    expect(model.requests[0]?.systemPrompt).toContain("Plan mode is active");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain("read_file");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("web_fetch");

    await expect(session.selectCollaborationMode("default")).resolves.toMatchObject({
      previousMode: "plan",
      mode: "default",
      changed: true,
    });
    await session.submit({ inputId: "default-input", text: "Implement it" });
    await session.waitForIdle();
    expect(model.requests[1]?.systemPrompt).not.toContain("Plan mode is active");
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toContain("write_file");
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toContain("bash");
    await session.close();
  });

  it("keeps a persisted Plan boundary read-only after an interrupted Turn is reopened", async () => {
    const root = await temporaryRoot();
    const firstModel = new ScriptedModel([{
      ...response("inspect before interruption"),
      toolCalls: [{ id: "plan-list", name: "list_files", arguments: { path: "." } }],
      stopReason: "toolUse",
    }]);
    const first = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
      collaborationMode: "plan",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: firstModel,
      createRunId: () => "persisted-plan-boundary-run",
    });
    const admitted = await first.submit({
      inputId: "persisted-plan-input",
      text: "Investigate this workspace",
    });
    await first.waitForIdle();
    expect(first.snapshot().blocker).toBe("step-allowance-exhausted");
    const runId = first.snapshot().runId!;
    const turnId = admitted.turnId!;
    await first.close();

    // Leave a provider request in-flight in the durable log. Reopening must
    // turn it into an interrupted Turn before any new host capabilities apply.
    const ledger = await JsonlLedger.open(join(root, "state", "runs", runId, "ledger.jsonl"));
    const currentEvents = await ledger.read({ runId });
    const currentWatermark = currentEvents.at(-1)?.globalOffset ?? 0;
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "turn.resumed",
      payload: { turnId, fromStep: 2, stepAllowance: 1 },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:persisted-plan:resumed",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "step.started",
      payload: { step: 2 },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:persisted-plan:step",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "model.requested",
      payload: {
        model: "scripted",
        requestHash: "sha256:persisted-plan-interrupted",
        contextWatermark: currentWatermark,
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:persisted-plan:request",
      visibility: "run",
    });
    await ledger.close();

    const resumedModel = new ScriptedModel([response("finished safely")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      // Start with the narrow host boundary, then deliberately widen it and
      // switch out of Plan mode before resuming the old Turn.
      collaborationMode: "default",
      runId,
    }, { mainModel: resumedModel });
    expect(resumed.snapshot().blocker).toBe("turn-interrupted");
    await resumed.selectPermissionProfile("full-access");
    await resumed.selectCollaborationMode("default");
    await resumed.resumeCurrent();
    await resumed.waitForIdle();

    expect(resumedModel.requests[0]?.systemPrompt).toContain("Plan mode is active");
    const names = resumedModel.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("process_start");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_search");
    await resumed.close();
  });

  it("fails closed to Plan and read-only tools when a legacy Turn has no boundary", async () => {
    const root = await temporaryRoot();
    const first = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        ...response("inspect before legacy conversion"),
        toolCalls: [{ id: "legacy-list", name: "list_files", arguments: { path: "." } }],
        stopReason: "toolUse",
      }]),
      createRunId: () => "legacy-boundary-run",
    });
    const admitted = await first.submit({ inputId: "legacy-input", text: "Inspect safely" });
    await first.waitForIdle();
    const runId = first.snapshot().runId!;
    await first.close();

    const ledgerPath = join(root, "state", "runs", runId, "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n");
    const rewritten = lines.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "turn.started") return line;
      const payload = { ...(event.payload as Record<string, unknown>) };
      delete payload.boundary;
      const withoutHash = { ...event, payload };
      return JSON.stringify({
        ...withoutHash,
        contentHash: computeEventContentHash(withoutHash as never),
      });
    });
    await writeFile(ledgerPath, `${rewritten.join("\n")}\n`, "utf8");

    const resumedModel = new ScriptedModel([response("legacy turn recovered safely")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
      collaborationMode: "default",
    }, { mainModel: resumedModel });
    await resumed.selectPermissionProfile("full-access");
    await resumed.selectCollaborationMode("default");
    await resumed.resumeCurrent();
    await resumed.waitForIdle();

    expect(resumedModel.requests[0]?.systemPrompt).toContain("Plan mode is active");
    const names = resumedModel.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("process_start");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_search");
    expect(admitted.turnId).toBeDefined();
    await resumed.close();
  });

  it("runs an opt-in Worker lane and delivers its result at a later Main boundary", async () => {
    const root = await temporaryRoot();
    let markWorkerStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let releaseWorker: ((value: ModelResponse) => void) | undefined;
    const workerModel = new ScriptedModel([async (request) => {
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
        "read_image",
      ]);
      markWorkerStarted?.();
      return new Promise<ModelResponse>((resolve) => {
        releaseWorker = resolve;
      });
    }]);
    const mainModel = new ScriptedModel([
      {
        ...response("Delegating a bounded inspection"),
        toolCalls: [{
          id: "delegate-1",
          name: "delegate_task",
          arguments: {
            taskId: "task-1",
            statement: "Inspect the package metadata",
            successCriteria: ["Return the package name"],
            maxModelTokens: 200,
            maxWallClockMs: 5_000,
          },
        }],
        stopReason: "toolUse",
      },
      async () => {
        await workerStarted;
        releaseWorker?.(response("package name: nausicaa"));
        return {
          ...response("Give the Worker one more boundary"),
          toolCalls: [{ id: "wait-1", name: "noop", arguments: {} }],
          stopReason: "toolUse",
        };
      },
      (request) => {
        expect(request.messages.some((message) => (
          message.role === "user"
          && message.content.includes("Worker task task-1 completed")
          && message.content.includes("package name: nausicaa")
        ))).toBe(true);
        return response("Worker result incorporated");
      },
    ]);
    const events: SessionRuntimeEvent[] = [];
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      workerModel: "scripted/worker",
      workerEnabled: true,
      policy: {
        maxMainStepsPerActivation: 4,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel,
      workerModel,
      tools: [noopTool],
      createRunId: () => "session-worker-run",
    });
    session.subscribe((event) => events.push(event));

    expect(session.snapshot()).toMatchObject({ workerEnabled: true });
    expect(session.workerTaskSummary()).toEqual({
      total: 0,
      queued: 0,
      running: 0,
      ready: 0,
      done: 0,
      failed: 0,
      stale: 0,
    });
    await session.submit({ inputId: "worker-input", text: "Inspect the package metadata" });
    await session.waitForIdle();

    expect(mainModel.requests[0]?.tools.some((tool) => tool.name === "delegate_task")).toBe(true);
    expect(workerModel.callCount).toBe(1);
    expect(mainModel.requests[2]?.messages.some((message) => (
      message.role === "user" && message.content.includes("Worker task task-1 completed")
    ))).toBe(true);
    expect(mainModel.requests[2]?.messages.some((message) => (
      message.role === "user" && message.content.includes("package name: nausicaa")
    ))).toBe(true);
    expect(durableEvents(events).some((event) => (
      event.type === "lane.registered"
      && event.laneId === "worker"
      && event.payload.kind === "worker"
    ))).toBe(true);
    expect(durableEvents(events).some((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.request"
    ))).toBe(true);
    expect(durableEvents(events).some((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
      && event.payload.message.payload.taskId === "task-1"
    ))).toBe(true);
    expect(session.workerTaskSummary()).toMatchObject({ total: 1, done: 1 });
    await session.close();

    const reopened = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      runId: "session-worker-run",
    }, {
      mainModel: new ScriptedModel([]),
      workerModel: new ScriptedModel([]),
    });
    const restoredSummary = reopened.workerTaskSummary();
    expect(restoredSummary).toMatchObject({ total: 1, done: 1 });
    restoredSummary.done = 0;
    expect(reopened.workerTaskSummary()).toMatchObject({ total: 1, done: 1 });
    await reopened.close();
  });

  it("keeps Worker work alive across completed Turns", async () => {
    const root = await temporaryRoot();
    let markWorkerStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let releaseWorker: ((value: ModelResponse) => void) | undefined;
    const workerModel = new ScriptedModel([async () => {
      markWorkerStarted?.();
      return new Promise<ModelResponse>((resolve) => {
        releaseWorker = resolve;
      });
    }]);
    let markWorkerResult: (() => void) | undefined;
    const workerResult = new Promise<void>((resolve) => {
      markWorkerResult = resolve;
    });
    const events: SessionRuntimeEvent[] = [];
    const mainModel = new ScriptedModel([
      {
        ...response("queued inspection"),
        toolCalls: [{
          id: "delegate-cross-turn",
          name: "delegate_task",
          arguments: {
            taskId: "cross-turn-task",
            statement: "Inspect the package name",
            maxModelTokens: 100,
            maxWallClockMs: 5_000,
          },
        }],
        stopReason: "toolUse",
      },
      response("first Turn is complete"),
      (request) => {
        expect(request.messages.some((message) => (
          message.role === "user"
          && message.content.includes("Worker task cross-turn-task completed")
          && message.content.includes("package name: nausicaa")
        ))).toBe(true);
        return response("second Turn used the Worker result");
      },
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      workerModel: "scripted/worker",
      workerEnabled: true,
      policy: {
        maxMainStepsPerActivation: 4,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel,
      workerModel,
      tools: [],
      createRunId: () => "cross-turn-worker-run",
    });
    session.subscribe((event) => {
      events.push(event);
      if (
        event.kind === "event"
        && event.event.type === "message.sent"
        && event.event.payload.message.payload.type === "task.result"
      ) {
        markWorkerResult?.();
      }
    });

    await session.submit({ inputId: "cross-turn-input", text: "Queue an inspection" });
    await workerStarted;
    await session.waitForIdle();
    expect(mainModel.callCount).toBe(2);
    expect(workerModel.callCount).toBe(1);

    releaseWorker?.(response("package name: nausicaa"));
    await workerResult;
    await session.submit({ inputId: "cross-turn-follow-up", text: "Use the inspection" });
    await session.waitForIdle();

    expect(mainModel.callCount).toBe(3);
    expect(durableEvents(events).filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
    ))).toHaveLength(1);
    await session.close();
  });

  it("cancels Run-scoped Worker work when the Session closes", async () => {
    const root = await temporaryRoot();
    let markWorkerStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const workerModel = new ScriptedModel([async () => {
      markWorkerStarted?.();
      return new Promise<ModelResponse>(() => {
        // The Session close signal must end this bounded Worker activation.
      });
    }]);
    const mainModel = new ScriptedModel([
      {
        ...response("queued inspection"),
        toolCalls: [{
          id: "delegate-close",
          name: "delegate_task",
          arguments: {
            taskId: "close-task",
            statement: "Inspect the package name",
            maxModelTokens: 100,
            maxWallClockMs: 5_000,
          },
        }],
        stopReason: "toolUse",
      },
      response("first Turn is complete"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      workerModel: "scripted/worker",
      workerEnabled: true,
      policy: {
        maxMainStepsPerActivation: 4,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel,
      workerModel,
      tools: [],
      createRunId: () => "close-worker-run",
    });

    await session.submit({ inputId: "close-input", text: "Queue an inspection" });
    await workerStarted;
    await session.waitForIdle();
    await session.close();

    expect(session.snapshot().status).toBe("closed");
    const ledger = await JsonlLedger.open(
      join(root, "state", "runs", "close-worker-run", "ledger.jsonl"),
    );
    const events = await ledger.read({ runId: "close-worker-run" });
    expect(events.some((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
    ))).toBe(false);
    await ledger.close();
  });

  it("passes the configured per-call output limit to Main", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("bounded answer")]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      maxOutputTokens: 8_192,
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "configured-output-limit-run",
    });

    await session.submit({ inputId: "bounded-input", text: "Answer fully" });
    await session.waitForIdle();

    expect(model.requests[0]?.maxOutputTokens).toBe(8_192);
    await session.close();

    await expect(SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      maxOutputTokens: 1_000_001,
    })).rejects.toThrow(/maxOutputTokens.*1.*1000000/i);
    await expect(SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { tetoMaxOutputTokens: 0 },
    })).rejects.toThrow("tetoMaxOutputTokens must be a positive integer");
  });

  it("delivers session images to Main without embedding them in the Ledger", async () => {
    const root = await temporaryRoot();
    const attachedImage = image("session-image-sentinel");
    const model = new ScriptedModel([response("image understood")]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "session-image-run");
    session.subscribe((event) => events.push(event));

    await session.submit({
      inputId: "image-input",
      text: "Inspect this screenshot",
      images: [attachedImage],
    });
    await session.waitForIdle();

    expect(model.requests[0]?.messages.find((message) => message.role === "user"))
      .toMatchObject({
        content: "Inspect this screenshot",
        images: [attachedImage],
      });
    await expect(session.transcript()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: "Inspect this screenshot",
        imageTypes: ["image/png"],
      }),
    ]));
    const userEvent = durableEvents(events).find((event) => event.type === "user.message");
    if (userEvent?.type !== "user.message") throw new Error("missing user message");
    await expect(session.readConversationMessage(userEvent.payload.messageRef)).resolves
      .toMatchObject({ images: [attachedImage] });
    const ledgerContents = await readFile(
      join(root, "state", "runs", "session-image-run", "ledger.jsonl"),
      "utf8",
    );
    expect(ledgerContents).not.toContain(attachedImage.data);
    await session.close();
  });

  it("keeps a revised Run Goal stable while each Turn gets its own objective", async () => {
    const root = await temporaryRoot();
    const first = await openSession(
      root,
      new ScriptedModel([response("你好，有什么可以帮你？")]),
      "goal-and-objective-run",
    );
    await first.submit({ inputId: "greeting", text: "你好" });
    await first.waitForIdle();
    const runId = first.snapshot().runId!;
    expect(first.snapshot().goal).toMatchObject({
      version: 1,
      statement: "Assist the user with tasks in the current workspace",
    });
    const revised = await first.reviseGoal("  Understand this repository  ");
    expect(revised).toMatchObject({ version: 2, statement: "Understand this repository" });
    await expect(first.reviseGoal("Understand this repository")).resolves.toEqual(revised);
    await first.close();

    const model = new ScriptedModel([response("不客气")]);
    const resumedEvents: SessionRuntimeEvent[] = [];
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    }, { mainModel: model });
    resumed.subscribe((event) => resumedEvents.push(event));
    await resumed.submit({ inputId: "thanks", text: "谢谢" });
    await resumed.waitForIdle();

    expect(model.requests[0]?.systemPrompt).toContain("Goal v2: Understand this repository");
    expect(durableEvents(resumedEvents)
      .find((event) => event.type === "navigation.updated")
      ?.payload.delta.activeObjective).toBe("谢谢");
    expect(resumed.snapshot().goal).toMatchObject({
      version: 2,
      statement: "Understand this repository",
    });
    await resumed.close();
    const reopenedLedger = await JsonlLedger.open(
      join(root, "state", "runs", runId, "ledger.jsonl"),
    );
    const projectionEvents = await reopenedLedger.read({ runId });
    expect(projectionEvents.filter((event) => event.type === "goal.revised")).toHaveLength(1);
    expect(projectionEvents
      .find((event) => event.type === "goal.revised")
      ?.payload.goal.statement).toBe("Understand this repository");
    await reopenedLedger.close();
  });

  it("delivers busy steering at the next safe Main boundary", async () => {
    const root = await temporaryRoot();
    const steeringImage = image("steering-image-sentinel");
    let releaseFirst: ((value: ModelResponse) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      () => new Promise<ModelResponse>((resolve) => {
        releaseFirst = resolve;
        markStarted?.();
      }),
      (request) => {
        const deliveredSteering = request.messages.find((message) =>
          message.role === "user"
          && message.content.includes("Use package.json instead"));
        expect(deliveredSteering).toMatchObject({ images: [steeringImage] });
        return response("steered answer");
      },
    ]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "steering-run", [noopTool]);
    session.subscribe((event) => events.push(event));

    const first = await session.submit({ inputId: "input-main", text: "Inspect setup" });
    await started;
    expect(model.requests[0]?.messages.some((message) =>
      message.role === "user" && message.images !== undefined,
    )).toBe(false);
    await expect(session.reviseGoal("Replace the mission while busy"))
      .rejects.toThrow("active Turn");
    const steering = await session.submit({
      inputId: "input-steer",
      text: "Use package.json instead",
      images: [steeringImage],
      delivery: "steering",
    });
    expect(steering.turnId).toBe(first.turnId);
    await expect(session.pendingInputs()).resolves.toEqual([
      {
        inputId: "input-steer",
        delivery: "steering",
        text: "Use package.json instead",
        images: [steeringImage],
        imageTypes: ["image/png"],
        sequence: 2,
        revision: 1,
      },
    ]);
    releaseFirst?.({
      ...response("reading"),
      toolCalls: [{ id: "noop-1", name: "noop", arguments: {} }],
      stopReason: "toolUse",
    });
    await session.waitForIdle();

    const durable = durableEvents(events);
    expect(durable.filter((event) => event.type === "turn.started")).toHaveLength(1);
    const delivered = durable.filter((event) => event.type === "input.delivered");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.payload.boundary).toBe("safe-step:2");
    expect(durable
      .filter((event) => event.type === "navigation.updated")
      .map((event) => event.payload.delta.activeObjective)).toEqual([
        "Inspect setup",
        "Inspect setup",
      ]);
    expect(new Set(model.requests.map((request) => request.sessionId)))
      .toEqual(new Set(["steering-run:main"]));
    const prefixHashes = durable
      .filter((event) => event.type === "model.requested")
      .map((event) => event.payload.prefixHash);
    expect(prefixHashes).toHaveLength(2);
    expect(new Set(prefixHashes).size).toBe(1);
    await session.close();
  });

  it("returns tool metadata and requested arguments in the transcript", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      {
        ...response("inspect"),
        toolCalls: [{
          id: "read-call",
          name: "noop",
          arguments: { path: "package.json", depth: 1 },
        }],
        stopReason: "toolUse",
      },
      response("finished"),
    ]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "tool-transcript", [noopTool]);
    session.subscribe((event) => events.push(event));

    await session.submit({ inputId: "tool-input", text: "Inspect" });
    await session.waitForIdle();

    const requested = durableEvents(events).find((event) => event.type === "tool.requested");
    expect(requested?.type).toBe("tool.requested");
    if (requested?.type !== "tool.requested") throw new Error("missing tool request");
    await expect(session.readToolArguments(requested.payload.argumentsRef)).resolves.toEqual({
      path: "package.json",
      depth: 1,
    });
    await expect(session.transcript()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        toolName: "noop",
        toolCallId: "read-call",
        operationId: requested.payload.operationId,
        isError: false,
        arguments: { path: "package.json", depth: 1 },
      }),
    ]));
    await session.close();
  });

  it("returns no pending inputs before a Run is attached", async () => {
    const root = await temporaryRoot();
    const session = await openSession(root, new ScriptedModel([]), "unattached-pending");
    await session.close();

    const reopened = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
    }, { mainModel: new ScriptedModel([]) });
    await expect(reopened.pendingInputs()).resolves.toEqual([]);
    await reopened.close();
  });

  it("waits at an activation allowance and resumes the same Turn", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([{
      ...response("one step"),
      toolCalls: [{ id: "noop-1", name: "noop", arguments: {} }],
      stopReason: "toolUse",
    }, response("done after resume")]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "resume-turn", [noopTool], 1);
    session.subscribe((event) => events.push(event));

    const admitted = await session.submit({ inputId: "resume-input", text: "Take two steps" });
    await session.waitForIdle();
    expect(session.snapshot().blocker).toBe("step-allowance-exhausted");
    await session.resumeCurrent();
    await session.waitForIdle();

    const durable = durableEvents(events);
    expect(durable.filter((event) => event.type === "turn.resumed")).toHaveLength(1);
    expect(durable
      .filter((event) => event.type === "step.started")
      .map((event) => event.payload.step)).toEqual([1, 2]);
    expect(durable.find((event) => event.type === "turn.completed")?.turnId)
      .toBe(admitted.turnId);
    expect(mainLaneStatuses(durable)).toEqual([
        "running",
        "waiting",
        "running",
        "ready",
      ]);
    await session.close();
  });

  it("surfaces an output limit and resumes with an explicit continuation boundary", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      { ...response("partial answer"), stopReason: "length" },
      response("continued answer"),
    ]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "output-limit-run");
    session.subscribe((event) => events.push(event));

    await session.submit({ inputId: "output-limit-input", text: "Give a long answer" });
    await session.waitForIdle();
    expect(session.snapshot().blocker).toBe("model-output-limit");
    expect(durableEvents(events)
      .find((event) => event.type === "turn.waiting")
      ?.payload.reason).toBe("model-output-limit");

    await session.resumeCurrent();
    await session.waitForIdle();

    const continuation = model.requests[1]?.messages.at(-1);
    expect(continuation?.role).toBe("user");
    expect(continuation?.content).toContain("Continue exactly where it stopped");
    await expect(session.transcript()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "partial answer" }),
      expect.objectContaining({ role: "assistant", content: "continued answer" }),
    ]));
    expect(session.snapshot().blocker).toBeUndefined();
    await session.close();
  });

  it("recovers a committed response before assistant and budget events", async () => {
    const root = await temporaryRoot();
    const first = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: {
        maxMainStepsPerActivation: 1,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: new ScriptedModel([{
        ...response("first committed step"),
        toolCalls: [{ id: "crash-noop", name: "noop", arguments: {} }],
        stopReason: "toolUse",
      }]),
      tools: [noopTool],
      createRunId: () => "crash-window-run",
    });
    const admitted = await first.submit({ inputId: "crash-input", text: "Keep working" });
    await first.waitForIdle();
    const runId = first.snapshot().runId!;
    const turnId = admitted.turnId!;
    await first.close();

    const stateDir = join(root, "state", "runs", runId);
    const store = await FileContentAddressedStore.open(join(stateDir, "store"));
    const orphanRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "orphan committed answer",
      toolCalls: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "turn.resumed",
      payload: { turnId, fromStep: 2, stepAllowance: 1 },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:crash-window:resumed",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "step.started",
      payload: { step: 2 },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:crash-window:step",
      visibility: "run",
    });
    const requested = await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "model.requested",
      payload: {
        model: "scripted",
        requestHash: "sha256:crash-window",
        contextWatermark: await ledger.watermark(),
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:crash-window:requested",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "model.completed",
      payload: {
        model: "scripted",
        responseRef: orphanRef,
        stopReason: "length",
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
      causationId: requested.eventId,
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:crash-window:completed",
      visibility: "run",
    });
    await ledger.append({
      runId,
      laneId: "teto",
      type: "budget.charged",
      payload: {
        laneId: "teto",
        usage: { input: 5_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: `run:${runId}`,
      idempotencyKey: "test:crash-window:teto-budget",
      visibility: "run",
    });
    await ledger.close();

    const resumedModel = new ScriptedModel([response("finished after recovery")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    }, { mainModel: resumedModel, tools: [noopTool] });
    await resumed.resumeCurrent();
    await resumed.waitForIdle();

    expect(resumedModel.requests[0]?.messages.map((message) => message.content))
      .toContain("orphan committed answer");
    // Main used 12 tokens before the crash and committed another 8 without a
    // charge. The 6,000-token Teto charge shares the same 10,000-token Run cap.
    expect(resumedModel.requests[0]?.maxOutputTokens).toBeGreaterThan(0);
    expect(resumedModel.requests[0]?.maxOutputTokens).toBeLessThanOrEqual(3_980);
    await resumed.close();

    const recoveredLedger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
    const recoveredEvents = await recoveredLedger.read({ runId });
    expect(mainLaneStatuses(recoveredEvents).at(-1)).toBe("ready");
    await recoveredLedger.close();
  });

  it("records a failed Main lane activation", async () => {
    const root = await temporaryRoot();
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, new ScriptedModel([
      async () => { throw new Error("provider unavailable"); },
    ]), "failed-lane-run");
    session.subscribe((event) => events.push(event));

    await session.submit({ inputId: "failed-input", text: "Try once" });
    await session.waitForIdle();

    expect(mainLaneStatuses(durableEvents(events))).toEqual(["running", "failed"]);
    await session.close();
  });

  it("cancels a waiting Turn and then promotes queued work", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      {
        ...response("needs another step"),
        toolCalls: [{ id: "waiting-noop", name: "noop", arguments: {} }],
        stopReason: "toolUse",
      },
      response("queued answer"),
    ]);
    const session = await openSession(root, model, "cancel-waiting", [noopTool], 1);

    await session.submit({ inputId: "waiting-input", text: "Wait" });
    await session.waitForIdle();
    expect(session.snapshot().blocker).toBe("step-allowance-exhausted");
    await session.submit({ inputId: "queued-input", text: "Continue differently" });
    await session.cancel("abandon waiting Turn");
    await session.waitForIdle();

    expect(model.callCount).toBe(2);
    expect(session.snapshot().blocker).toBeUndefined();
    await session.close();
  });

  it("deduplicates a retried inputId and rejects conflicting reuse", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("done")]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "dedupe-run");
    session.subscribe((event) => events.push(event));

    await session.submit({ inputId: "stable-input", text: "Do it" });
    const duplicate = await session.submit({ inputId: "stable-input", text: "Do it" });
    expect(duplicate.status).toBe("duplicate");
    await expect(session.submit({ inputId: "stable-input", text: "Different" }))
      .rejects.toThrow("reused with different content");
    await session.waitForIdle();
    expect(durableEvents(events).filter((event) => event.type === "input.admitted"))
      .toHaveLength(1);
    await session.close();
  });

  it("includes image content in input idempotency", async () => {
    const root = await temporaryRoot();
    const originalImage = image("stable-image");
    const changedImage = image("changed-image");
    const session = await openSession(
      root,
      new ScriptedModel([response("done")]),
      "image-dedupe-run",
    );

    await session.submit({
      inputId: "stable-image-input",
      text: "Inspect",
      images: [originalImage],
    });
    await expect(session.submit({
      inputId: "stable-image-input",
      text: "Inspect",
      images: [{ ...originalImage }],
    })).resolves.toMatchObject({ status: "duplicate" });
    await expect(session.submit({
      inputId: "stable-image-input",
      text: "Inspect",
      images: [changedImage],
    })).rejects.toThrow("reused with different content");
    await session.waitForIdle();
    await session.close();
  });

  it("preserves images when a waiting Turn is reopened and resumed", async () => {
    const root = await temporaryRoot();
    const attachedImage = image("resumed-session-image");
    const firstModel = new ScriptedModel([{
      ...response("inspect another file"),
      toolCalls: [{ id: "resume-image-noop", name: "noop", arguments: {} }],
      stopReason: "toolUse",
    }]);
    const first = await openSession(
      root,
      firstModel,
      "reopened-image-run",
      [noopTool],
      1,
    );
    await first.submit({
      inputId: "reopened-image-input",
      text: "Use this screenshot",
      images: [attachedImage],
    });
    await first.waitForIdle();
    expect(first.snapshot().blocker).toBe("step-allowance-exhausted");
    const runId = first.snapshot().runId!;
    await first.close();

    const resumedModel = new ScriptedModel([response("finished from screenshot")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    }, {
      mainModel: resumedModel,
      tools: [noopTool],
    });
    await resumed.resumeCurrent();
    await resumed.waitForIdle();

    expect(resumedModel.requests[0]?.messages.find((message) =>
      message.role === "user" && message.content === "Use this screenshot",
    )).toMatchObject({ images: [attachedImage] });
    expect(firstModel.requests[0]?.sessionId).toBe("reopened-image-run:main");
    expect(resumedModel.requests[0]?.sessionId).toBe(firstModel.requests[0]?.sessionId);
    await expect(resumed.transcript()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: "Use this screenshot",
        imageTypes: ["image/png"],
      }),
    ]));
    await resumed.close();

    const ledger = await JsonlLedger.open(
      join(root, "state", "runs", runId, "ledger.jsonl"),
    );
    const requested = (await ledger.read({ runId }))
      .filter((event) => event.type === "model.requested");
    expect(requested).toHaveLength(2);
    expect(requested.every((event) => event.payload.sessionId === "reopened-image-run:main"))
      .toBe(true);
    expect(new Set(requested.map((event) => event.payload.prefixHash)).size).toBe(1);
    await ledger.close();
  });

  it("refuses to attach a Run from another canonical workspace", async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    const dataDir = join(firstRoot, "state");
    const first = await SessionController.open({
      workspace: firstRoot,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("done")]),
      createRunId: () => "workspace-run",
    });
    await first.submit({ inputId: "workspace-input", text: "Do it" });
    await first.waitForIdle();
    await first.close();

    await expect(SessionController.open({
      workspace: secondRoot,
      dataDir,
      model: "scripted",
      runId: "workspace-run",
    })).rejects.toThrow("belongs to");
  });

  it("serializes close against later commands", async () => {
    const root = await temporaryRoot();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      async (request) => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return response("cancelled");
      },
    ]);
    const session = await openSession(root, model, "close-race");

    await session.submit({ inputId: "close-input", text: "Start" });
    await started;
    const closing = session.close();
    await expect(session.submit({ inputId: "late-input", text: "Too late" }))
      .rejects.toThrow(/closing|closed/);
    await closing;
    expect(session.snapshot().status).toBe("closed");
  });

  it("promotes a queued follow-up after the current Turn settles", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("first"), response("second")]);
    const session = await openSession(root, model, "queued-follow-up");

    await session.submit({ inputId: "first-input", text: "First" });
    const queued = await session.submit({
      inputId: "follow-up-input",
      text: "Follow up",
      delivery: "follow-up",
    });
    expect(queued.delivery).toBe("follow-up");
    await session.waitForIdle();

    expect(model.requests).toHaveLength(2);
    expect(session.snapshot().status).toBe("idle");
    await session.close();
  });

  it("replaces and withdraws pending inputs with durable revisions", async () => {
    const root = await temporaryRoot();
    const queuedImage: UserImage = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("queued-image").toString("base64"),
    };
    let releaseFirst: ((response: ModelResponse) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      () => new Promise<ModelResponse>((resolve) => {
        releaseFirst = resolve;
        markStarted?.();
      }),
      (request) => {
        expect(request.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Use the revised request" }),
        ]));
        expect(request.messages.some((message) => (
          message.role === "user" && message.content === "Original queued request"
        ))).toBe(false);
        return response("revised answer");
      },
    ]);
    const session = await openSession(root, model, "pending-mutations");

    await session.submit({ inputId: "active-input", text: "Keep running" });
    await started;
    await session.submit({
      inputId: "replace-input",
      text: "Original queued request",
      images: [queuedImage],
      delivery: "follow-up",
    });
    await session.submit({
      inputId: "withdraw-input",
      text: "Withdraw me",
      delivery: "follow-up",
    });

    await expect(session.replacePendingInput("replace-input", 1, {
      text: "Use the revised request",
      delivery: "follow-up",
    })).resolves.toBe("applied");
    await expect(session.replacePendingInput("replace-input", 1, {
      text: "Stale replacement",
      delivery: "follow-up",
    })).resolves.toBe("stale");
    await expect(session.pendingInputs()).resolves.toEqual([
      {
        inputId: "replace-input",
        delivery: "follow-up",
        text: "Use the revised request",
        images: [queuedImage],
        imageTypes: ["image/png"],
        sequence: 2,
        revision: 2,
      },
      {
        inputId: "withdraw-input",
        delivery: "follow-up",
        text: "Withdraw me",
        sequence: 3,
        revision: 1,
      },
    ]);
    await expect(session.replacePendingInput("replace-input", 2, {
      text: "Use the revised request",
      delivery: "follow-up",
      images: [],
    })).resolves.toBe("applied");
    expect((await session.pendingInputs())[0]).toEqual({
      inputId: "replace-input",
      delivery: "follow-up",
      text: "Use the revised request",
      images: [],
      sequence: 2,
      revision: 3,
    });
    await expect(session.withdrawPendingInput("withdraw-input", 1)).resolves.toBe("applied");
    await expect(session.withdrawPendingInput("withdraw-input", 1)).resolves.toBe("stale");

    releaseFirst?.(response("first answer"));
    await session.waitForIdle();
    expect(model.requests).toHaveLength(2);
    await expect(session.replacePendingInput("replace-input", 3, {
      text: "Too late",
      delivery: "follow-up",
    })).resolves.toBe("stale");
    await expect(session.pendingInputs()).resolves.toEqual([]);
    await session.close();

    const reopened = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId: "pending-mutations",
    }, { mainModel: new ScriptedModel([]) });
    await expect(reopened.pendingInputs()).resolves.toEqual([]);
    await reopened.close();
  });

  it("publishes and coalesces resolutions before automatically resuming the same Turn", async () => {
    const root = await temporaryRoot();
    const first = await openSession(
      root,
      new ScriptedModel([{
        ...response("write started"),
        toolCalls: [{ id: "initial-noop", name: "noop", arguments: {} }],
        stopReason: "toolUse",
      }]),
      "unknown-resume",
      [noopTool],
      1,
    );
    const admitted = await first.submit({ inputId: "unknown-input", text: "Finish" });
    await first.waitForIdle();
    const runId = first.snapshot().runId!;
    const turnId = admitted.turnId!;
    expect(first.snapshot().blocker).toBe("step-allowance-exhausted");
    await first.close();

    const store = await FileContentAddressedStore.open(
      join(root, "state", "runs", runId, "store"),
    );
    const ledger = await JsonlLedger.open(join(root, "state", "runs", runId, "ledger.jsonl"));
    for (const operation of [
      {
        operationId: "unknown-op-1",
        toolCallId: "unknown-call-1",
        arguments: { path: "src/first.ts", content: "first" },
      },
      {
        operationId: "unknown-op-2",
        toolCallId: "unknown-call-2",
        arguments: { path: "src/second.ts", content: "second" },
      },
    ]) {
      const argumentsRef = await store.put(
        JSON.stringify(operation.arguments),
        "application/vnd.nausicaa.tool-arguments+json",
      );
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.requested",
        payload: {
          operationId: operation.operationId,
          toolCallId: operation.toolCallId,
          name: "write_file",
          argumentsRef,
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: `test:${operation.operationId}:requested`,
        visibility: "run",
      });
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.unknown",
        payload: {
          operationId: operation.operationId,
          toolCallId: operation.toolCallId,
          name: "write_file",
          reason: "provider response was lost",
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: `test:${operation.operationId}:unknown`,
        visibility: "run",
      });
    }
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "turn.waiting",
      payload: {
        turnId,
        reason: "operation-unknown",
        lastCommittedStep: 1,
        resumeRequires: "operation-resolution",
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:unknown-waiting",
      visibility: "run",
    });
    await ledger.close();

    const resumedModel = new ScriptedModel([response("recovered")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    }, { mainModel: resumedModel, tools: [noopTool] });
    const liveEvents: SessionRuntimeEvent[] = [];
    resumed.subscribe((event) => liveEvents.push(event));

    const initialUnknown = (await resumed.transcript()).filter((entry) => (
      entry.role === "tool" && entry.operationId.startsWith("unknown-op-")
    ));
    expect(initialUnknown).toMatchObject([
      { status: "unknown", operationId: "unknown-op-1", turnId },
      { status: "unknown", operationId: "unknown-op-2", turnId },
    ]);
    await expect(resumed.resumeCurrent()).rejects.toThrow("Resolve unknown-op-1");

    await resumed.resolveOperation("unknown-op-1");
    expect(resumed.snapshot().blocker).toBe("operation-unknown:unknown-op-2");
    await expect(resumed.resumeCurrent()).rejects.toThrow("Resolve unknown-op-2");
    expect(durableEvents(liveEvents).filter((event) => (
      event.type === "tool.failed" && event.payload.operationId === "unknown-op-1"
    ))).toMatchObject([{
      turnId,
      payload: { resolution: "operator" },
    }]);
    const afterFirstResolution = (await resumed.transcript()).filter((entry) => (
      entry.role === "tool" && entry.operationId.startsWith("unknown-op-")
    ));
    expect(afterFirstResolution).toMatchObject([
      { status: "failed", operationId: "unknown-op-1", turnId },
      { status: "unknown", operationId: "unknown-op-2", turnId },
    ]);
    expect(resumedModel.callCount).toBe(0);
    expect(durableEvents(liveEvents).filter((event) => event.type === "turn.resumed"))
      .toHaveLength(0);

    await resumed.resolveOperation("unknown-op-1");
    expect(durableEvents(liveEvents).filter((event) => (
      event.type === "tool.failed" && event.payload.operationId === "unknown-op-1"
    ))).toHaveLength(1);
    await resumed.resolveOperation("unknown-op-2");
    await resumed.waitForIdle();
    const resolvedTranscript = (await resumed.transcript()).filter((entry) => (
      entry.role === "tool" && entry.operationId.startsWith("unknown-op-")
    ));
    expect(resolvedTranscript).toMatchObject([
      { status: "failed", operationId: "unknown-op-1", turnId },
      { status: "failed", operationId: "unknown-op-2", turnId },
    ]);
    expect(resolvedTranscript).toHaveLength(2);

    expect(resumedModel.callCount).toBe(1);
    expect(durableEvents(liveEvents).filter((event) => event.type === "turn.resumed"))
      .toMatchObject([{ turnId }]);
    await resumed.close();

    const restarted = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    });
    const restartedTranscript = (await restarted.transcript()).filter((entry) => (
      entry.role === "tool" && entry.operationId.startsWith("unknown-op-")
    ));
    expect(restartedTranscript).toMatchObject([
      { status: "failed", operationId: "unknown-op-1", turnId },
      { status: "failed", operationId: "unknown-op-2", turnId },
    ]);
    expect(restartedTranscript).toHaveLength(2);
    await restarted.close();
  });

  it("promotes pending input after the last unknown outcome of a cancelled Turn settles", async () => {
    const root = await temporaryRoot();
    const first = await openSession(
      root,
      new ScriptedModel([{
        ...response("write started"),
        toolCalls: [{ id: "cancel-noop", name: "noop", arguments: {} }],
        stopReason: "toolUse",
      }]),
      "cancelled-unknown",
      [noopTool],
      1,
    );
    const admitted = await first.submit({ inputId: "cancelled-input", text: "Start" });
    await first.waitForIdle();
    const runId = first.snapshot().runId!;
    const turnId = admitted.turnId!;
    await first.close();

    const store = await FileContentAddressedStore.open(
      join(root, "state", "runs", runId, "store"),
    );
    const argumentsRef = await store.put(
      JSON.stringify({ path: "src/cancelled.ts", content: "pending" }),
      "application/vnd.nausicaa.tool-arguments+json",
    );
    const ledger = await JsonlLedger.open(join(root, "state", "runs", runId, "ledger.jsonl"));
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "cancelled-unknown-op",
        toolCallId: "cancelled-unknown-call",
        name: "write_file",
        argumentsRef,
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:cancelled-unknown:requested",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "tool.unknown",
      payload: {
        operationId: "cancelled-unknown-op",
        toolCallId: "cancelled-unknown-call",
        name: "write_file",
        reason: "provider response was lost",
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:cancelled-unknown:unknown",
      visibility: "run",
    });
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "turn.waiting",
      payload: {
        turnId,
        reason: "operation-unknown",
        lastCommittedStep: 1,
        resumeRequires: "operation-resolution",
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:cancelled-unknown:waiting",
      visibility: "run",
    });
    await ledger.close();

    const queuedModel = new ScriptedModel([response("queued work completed")]);
    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    }, { mainModel: queuedModel, tools: [noopTool] });
    const liveEvents: SessionRuntimeEvent[] = [];
    resumed.subscribe((event) => liveEvents.push(event));
    await resumed.submit({ inputId: "queued-after-cancel", text: "Do the next task" });
    await resumed.cancel("abandon uncertain Turn");
    expect(queuedModel.callCount).toBe(0);
    expect(resumed.snapshot().blocker).toBe("operation-unknown:cancelled-unknown-op");

    await resumed.resolveOperation("cancelled-unknown-op");
    await resumed.waitForIdle();

    expect(queuedModel.callCount).toBe(1);
    expect(durableEvents(liveEvents).filter((event) => event.type === "turn.resumed"))
      .toHaveLength(0);
    expect(durableEvents(liveEvents).filter((event) => (
      event.type === "turn.started" && event.payload.inputId === "queued-after-cancel"
    ))).toHaveLength(1);
    expect(durableEvents(liveEvents).find((event) => (
      event.type === "turn.cancelled" && event.turnId === turnId
    ))).toBeDefined();
    expect(resumed.snapshot().blocker).toBeUndefined();
    await resumed.close();
  });
});

async function openSession(
  root: string,
  model: ScriptedModel,
  runId: string,
  tools: readonly AgentTool[] = [],
  maxSteps = 4,
): Promise<SessionController> {
  return SessionController.open({
    workspace: root,
    dataDir: join(root, "state"),
    model: "scripted",
    policy: {
      maxMainStepsPerActivation: maxSteps,
      maxModelTokens: 10_000,
      tetoEnabled: false,
    },
  }, {
    mainModel: model,
    tools,
    createRunId: () => runId,
  });
}

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

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

function enabledFukaiPolicy() {
  return {
    enabled: true,
    provider: "pi-ai" as const,
    maxInputTokens: 2_000,
    maxOutputTokens: 500,
    maxWallClockMs: 30_000,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    minimumGainTokens: 1,
  };
}

function image(
  payload: string,
  mimeType: UserImage["mimeType"] = "image/png",
): UserImage {
  return {
    type: "image",
    data: Buffer.from(payload).toString("base64"),
    mimeType,
  };
}

function durableEvents(events: readonly SessionRuntimeEvent[]) {
  return events
    .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => (
      event.kind === "event"
    ))
    .map((event) => event.event);
}

function mainLaneStatuses(events: ReturnType<typeof durableEvents>) {
  return events.flatMap((event) => (
    event.type === "lane.status" && event.laneId === "main"
      ? [event.payload.status]
      : []
  ));
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-session-"));
  roots.push(root);
  return root;
}
