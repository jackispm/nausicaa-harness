import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import type { AgentTool, ModelResponse, ModelStreamEvent } from "../../src/domain/ports.js";
import { readWorkspaceAgentAwareness } from "../../src/cli/agent-topology-source.js";
import { createCrossRunMessageId, createCrossRunRouteId, envelopeToA2AMessage, normalizeEnvelope } from "../../src/a2a/cross-run-contract.js";
import { createCrossRunRuntimeTool } from "../../src/runtime/cross-run-runtime.js";
import { createLocalCrossRunComposition } from "../../src/runtime/local-cross-run-composition.js";
import { executeRun } from "../../src/runtime/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { listWorkspaceRuns, SessionController } from "../../src/runtime/session-controller.js";
import { LocalSessionRegistry } from "../../src/runtime/local-session-registry.js";
import { enqueueLocalSessionMessage } from "../../src/runtime/local-session-transport.js";
import * as sessionTransport from "../../src/runtime/local-session-transport.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";
import { MemoryLedger } from "../../src/ledger/memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local CLI Cross-Run composition", () => {
  it.each(["sessionId", "runId"] as const)("reaches a fresh Session by %s before its first user conversation", async (selectorField) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-fresh-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([reply("received first message")]);
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "fresh-target-session",
      policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => "fresh-target-run" });
    try {
      expect(target.snapshot().runId).toBeUndefined();
      expect(await readdir(join(dataDir, "runs")).catch(() => [])).toEqual([]);
      const awareness = await readWorkspaceAgentAwareness(dataDir, root);
      const endpoint = awareness.records?.find((record) => record.endpoint.sessionId === target.sessionId)?.endpoint;
      expect(endpoint).toBeDefined();
      const receipt = await sendNote(root, dataDir, endpoint![selectorField], "FIRST_REMOTE_MESSAGE");
      expect(receipt).toMatchObject({ status: "queued", target: { sessionId: target.sessionId } });
      await waitFor(() => model.callCount === 1);
      await target.waitForIdle();
      expect(model.requests[0]?.messages.some((message) => message.content.includes("FIRST_REMOTE_MESSAGE"))).toBe(true);
      expect(target.snapshot().runId).toBe("fresh-target-run");
      const events = await readEvents(dataDir, "fresh-target-run");
      expect(events.filter((event) => event.type === "message.sent")).toHaveLength(1);
      expect(events.filter((event) => event.type === "input.admitted")).toHaveLength(1);
      expect((await target.transcript()).filter((entry) => entry.role === "agent")).toMatchObject([
        { content: "FIRST_REMOTE_MESSAGE", direction: "incoming" },
      ]);
    } finally {
      await target.close();
    }
  });

  it.each(["streaming", "tool"] as const)("consumes a message once at a safe boundary while the target is %s", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-busy-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    class StreamingModel extends ScriptedModel {
      override async *stream(request: Parameters<ScriptedModel["stream"]>[0]): AsyncIterable<ModelStreamEvent> {
        yield { type: "start" };
        if (this.callCount === 0) {
          yield { type: "text-delta", delta: "Answer in progress" };
          started = true;
        }
        yield { type: "done", response: await this.complete(request) };
      }
    }
    const first = phase === "streaming" ? reply("original answer") : {
      ...reply("working"), stopReason: "toolUse" as const,
      toolCalls: [{ id: "busy-tool", name: "wait_tool", arguments: {} }],
    };
    const steps = [
      async () => { if (phase === "streaming") await gate; return first; },
      reply("received while busy"),
    ];
    const model = phase === "streaming" ? new StreamingModel(steps) : new ScriptedModel(steps);
    const tool: AgentTool = {
      definition: { name: "wait_tool", description: "Wait at the tool boundary", parameters: { type: "object" } },
      async execute() { started = true; await gate; return { content: "done", isError: false }; },
    };
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "busy-target-session",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 3 },
    }, { mainModel: model, tools: [tool], createRunId: () => "busy-target-run" });
    const events: AnyEvent[] = [];
    target.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
    try {
      await target.submit({ inputId: "start", text: "Start answering" });
      await waitFor(() => started);
      expect(await sendNote(root, dataDir, target.sessionId, "MESSAGE_WHILE_BUSY"))
        .toMatchObject({ status: "queued" });
      await waitFor(() => events.some((event) => event.type === "input.admitted" && event.payload.inputId.startsWith("a2a:")));
      expect(model.callCount).toBe(1);
      expect(events.find((event) => event.type === "input.admitted" && event.payload.inputId.startsWith("a2a:")))
        .toMatchObject({ payload: { delivery: "steering" } });
      release();
      await target.waitForIdle();
      expect(model.callCount).toBe(2);
      expect(model.requests[1]?.messages.filter((message) => message.content.includes("MESSAGE_WHILE_BUSY")))
        .toHaveLength(1);
      expect(events.filter((event) => event.type === "message.sent")).toHaveLength(1);
    } finally {
      release();
      await target.close();
    }
  });

  it("ignores a corrupt first-message record without blocking a fresh Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-corrupt-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([reply("received valid message")]);
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "corrupt-target-session",
      policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => "corrupt-target-run" });
    try {
      await enqueueLocalSessionMessage({ dataDir, targetRunId: "corrupt-target-run",
        queuedAt: "2026-01-01T00:00:00.000Z",
        message: { messageId: "malformed-first", runId: "corrupt-target-run",
          targetEndpoint: { sessionId: target.sessionId, runId: "corrupt-target-run", laneId: "main" },
          sourceEndpoint: {}, to: "main" } as Parameters<typeof enqueueLocalSessionMessage>[0]["message"],
      });
      await target.reconcileExternalMessages();
      expect(target.snapshot().runId).toBeUndefined();
      expect(await sendNote(root, dataDir, target.sessionId, "VALID_AFTER_CORRUPT")).toMatchObject({ status: "queued" });
      await waitFor(() => model.callCount === 1);
      await target.waitForIdle();
      expect(model.requests[0]?.messages.some((message) => message.content.includes("VALID_AFTER_CORRUPT"))).toBe(true);
    } finally {
      await target.close();
    }
  });

  it("keeps an old Run message out of a new conversation when attachment changes during admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-switch-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    let runSequence = 0;
    const model = new ScriptedModel([reply("seed"), reply("new conversation"), reply("old Run reply")]);
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "switch-target-session",
      policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => `switch-target-${++runSequence}` });
    let switched: Promise<void> | undefined;
    try {
      await target.submit({ inputId: "seed", text: "Seed the old Run" });
      await target.waitForIdle();
      target.subscribe((runtimeEvent) => {
        if (runtimeEvent.kind === "event" && runtimeEvent.event.type === "message.sent") {
          switched ??= target.newRun();
        }
      });
      expect(await sendNote(root, dataDir, target.sessionId, "OLD_RUN_ONLY")).toMatchObject({ status: "queued" });
      await target.reconcileExternalMessages();
      await switched;
      await target.waitForIdle();
      expect(target.snapshot().runId).toBeUndefined();
      expect(model.callCount).toBe(1);
      await target.submit({ inputId: "new-conversation", text: "UNRELATED_NEW_REQUEST" });
      await target.waitForIdle();
      expect(model.requests[1]?.messages.some((message) => message.content.includes("OLD_RUN_ONLY"))).toBe(false);
      await target.attachRun("switch-target-1");
      await target.reconcileExternalMessages();
      await target.waitForIdle();
      expect(model.requests[2]?.messages.some((message) => message.content.includes("OLD_RUN_ONLY"))).toBe(true);
    } finally {
      await target.close();
    }
  });

  it("does not create a first Run from a queue message with a forged envelope body", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-forged-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([reply("must not run")]);
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "forged-target-session", policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => "forged-target-run" });
    try {
      const source = { workspaceId: "local-workspace", sessionId: "source-session", runId: "source-run", laneId: "main" };
      const destination = { workspaceId: "local-workspace", sessionId: target.sessionId, runId: "forged-target-run", laneId: "main" };
      const request = { conversationId: "conversation", threadId: "thread", correlationId: "correlation",
        idempotencyKey: "forged-message", visibility: "run" as const, priority: 0,
        payload: { type: "message.inform" as const, text: "Original content" },
      };
      const routeId = createCrossRunRouteId(source, destination, request.idempotencyKey);
      const message = envelopeToA2AMessage(normalizeEnvelope({ protocolVersion: 1, ...request,
        source, target: destination, relationship: "direct", routeId,
        messageId: createCrossRunMessageId(routeId, request), createdAt: new Date().toISOString(), artifacts: [],
      }));
      message.payload = { type: "message.inform", text: "FORGED_CONTENT" };
      await enqueueLocalSessionMessage({ dataDir, targetRunId: destination.runId, message });
      await target.reconcileExternalMessages();
      expect(target.snapshot().runId).toBeUndefined();
      expect(model.callCount).toBe(0);
    } finally {
      await target.close();
    }
  });

  it.each(["new", "close", "attach"] as const)("keeps a queued first message recoverable when the fresh Session immediately performs %s", async (action) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-reservation-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([]);
    let sequence = 0;
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "reserved-target-session", policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => `reserved-target-${++sequence}` });
    let resumed: SessionController | undefined;
    try {
      expect(await sendNote(root, dataDir, target.sessionId, "RECOVER_FIRST_MESSAGE")).toMatchObject({ status: "queued" });
      if (action === "new") await target.newRun();
      else if (action === "close") await target.close();
      else await target.attachRun("note-source-run");
      await target.close();
      expect(model.callCount).toBe(0);
      expect((await listWorkspaceRuns(dataDir, root)).some((run) => run.runId === "reserved-target-1")).toBe(true);
      const resumedModel = new ScriptedModel([reply("recovered first message")]);
      resumed = await SessionController.open({ workspace: root, dataDir, model: "scripted", runId: "reserved-target-1",
        policy: { tetoEnabled: false },
      }, { mainModel: resumedModel });
      await resumed.reconcileExternalMessages();
      await resumed.waitForIdle();
      expect(resumedModel.callCount).toBe(1);
      expect(resumedModel.requests[0]?.messages.some((message) => message.content.includes("RECOVER_FIRST_MESSAGE"))).toBe(true);
    } finally {
      await resumed?.close();
      await target.close();
    }
  });

  it.each(["new", "close"] as const)("does not report queued when detached admission races with %s", async (action) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-admission-race-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([]);
    let sequence = 0;
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "racing-target-session", policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => `racing-target-${++sequence}` });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admissionReached = new Promise<void>((resolve) => { reached = resolve; });
    const originalEnqueue = sessionTransport.enqueueLocalSessionMessage;
    const enqueue = vi.spyOn(sessionTransport, "enqueueLocalSessionMessage").mockImplementation(async (options) => {
      reached();
      await gate;
      return originalEnqueue(options);
    });
    let sending: Promise<unknown> | undefined;
    try {
      sending = sendNote(root, dataDir, target.sessionId, "LATE_FIRST_MESSAGE");
      await admissionReached;
      if (action === "new") await target.newRun();
      else await target.close();
      release();
      expect(await sending).toMatchObject({ status: "uncertain", diagnostic: "target-unavailable" });
      expect(model.callCount).toBe(0);
    } finally {
      release();
      await sending;
      enqueue.mockRestore();
      await target.close();
    }
  });

  it("keeps a fresh Session reachable after a rejected attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-attach-rejected-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const model = new ScriptedModel([reply("received after rejected attachment")]);
    const target = await SessionController.open({
      workspace: root, dataDir, model: "scripted", sessionId: "attach-rejected-session", policy: { tetoEnabled: false },
    }, { mainModel: model, createRunId: () => "attach-rejected-run" });
    try {
      await expect(target.attachRun("missing-run")).rejects.toThrow();
      expect(target.snapshot().runId).toBeUndefined();
      expect(await sendNote(root, dataDir, target.sessionId, "AFTER_REJECTED_ATTACH")).toMatchObject({ status: "queued" });
      await waitFor(() => model.callCount === 1);
      await target.waitForIdle();
      expect(model.requests[0]?.messages.some((message) => message.content.includes("AFTER_REJECTED_ATTACH"))).toBe(true);
    } finally {
      await target.close();
    }
  });

  it("does not resolve a durable Run without a live Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");

    const target = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Leave this Run resumable",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "partial",
        stopReason: "toolUse",
        toolCalls: [{ id: "target-noop", name: "noop", arguments: {} }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "target-run",
    });
    expect(target.completed).toBe(false);

    const sourceModel = new ScriptedModel([
      {
        content: "send",
        stopReason: "toolUse",
        toolCalls: [{
          id: "source-message",
          name: "agent_message",
          arguments: {
            target: { relationship: "direct", id: "target-run" },
            payload: { type: "message.inform", text: "hello from source" },
          },
        }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
      (request) => {
        const result = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "agent_message"
        ));
        expect(result?.content).toContain('"code":"target-unavailable"');
        return {
          content: "not sent",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    ]);
    const source = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Send a message",
      policy: { maxMainSteps: 2, tetoEnabled: false },
    }, {
      mainModel: sourceModel,
      createRunId: () => "source-run",
      crossRun: createLocalCrossRunComposition({ workspace: root, dataDir }),
    });

    expect(source).toMatchObject({ completed: true, finalText: "not sent" });
    expect(sourceModel.requests[0]?.tools.map((tool) => tool.name)).toContain("agent_message");
    const targetLedger = await readFile(join(target.stateDir, "ledger.jsonl"), "utf8");
    expect(targetLedger).not.toContain("hello from source");
  });

  it("does not classify unrelated root Runs as siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-roots-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");

    await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Leave this root Run resumable",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "partial",
        stopReason: "toolUse",
        toolCalls: [{ id: "root-noop", name: "noop", arguments: {} }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "root-target",
    });

    const sourceModel = new ScriptedModel([
      {
        content: "try sibling",
        stopReason: "toolUse",
        toolCalls: [{
          id: "root-sibling-message",
          name: "agent_message",
          arguments: {
            target: { relationship: "sibling", id: "root-target" },
            payload: { type: "message.inform", text: "must not route" },
          },
        }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
      (request) => {
        const result = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "agent_message"
        ));
        expect(result?.content).toContain('"code":"target-unavailable"');
        return {
          content: "not routed",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    ]);
    const source = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Do not route to an unrelated root",
      policy: { maxMainSteps: 2, tetoEnabled: false },
    }, {
      mainModel: sourceModel,
      createRunId: () => "root-source",
      crossRun: createLocalCrossRunComposition({ workspace: root, dataDir }),
    });

    expect(source).toMatchObject({ completed: true, finalText: "not routed" });
    const targetLedger = await readFile(
      join(root, ".nausicaa", "runs", "root-target", "ledger.jsonl"),
      "utf8",
    );
    expect(targetLedger).not.toContain("must not route");
  });

  it("keeps same-Run sessions distinct through roster lookup and message admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-roster-sessions-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");
    const source = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Create the source Run",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "source",
        stopReason: "stop",
        toolCalls: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      createRunId: () => "roster-source-run",
    });
    const target = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Create the target Run",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "target",
        stopReason: "stop",
        toolCalls: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      createRunId: () => "roster-target-run",
    });
    const sessionA = new LocalSessionRegistry({
      dataDir,
      workspace: root,
      sessionId: "target-session-a",
    });
    const sessionB = new LocalSessionRegistry({
      dataDir,
      workspace: root,
      sessionId: "target-session-b",
    });
    await sessionA.start({ runId: target.runId, state: "idle" });
    await sessionB.start({ runId: target.runId, state: "idle" });
    try {
      const composition = createLocalCrossRunComposition({
        workspace: root,
        dataDir,
        sessionId: "source-session",
        proofToken: "roster-proof",
      });
      const senderFactory = composition.sender;
      if (typeof senderFactory !== "function") throw new Error("expected sender factory");
      const senderContext = {
        runId: source.runId,
        laneId: "main",
        sessionId: "source-session",
        workspace: root,
        ledger: new MemoryLedger(),
        store: new MemoryContentAddressedStore(),
      };
      const sender = await senderFactory(senderContext);
      const roster = await composition.routerOptions?.roster?.list(sender);
      const targetEntries = roster?.entries.filter((entry) => entry.endpoint.runId === target.runId) ?? [];
      expect(targetEntries.map((entry) => entry.endpoint.sessionId)).toEqual([
        "target-session-a",
        "target-session-b",
      ]);

      const resolver = composition.routerOptions?.resolver;
      if (resolver === undefined) throw new Error("expected local target resolver");
      await expect(resolver.resolve(
        { relationship: "direct", id: target.runId },
        sender,
      )).rejects.toMatchObject({ code: "selector-ambiguous" });
      await expect(resolver.resolve(
        { relationship: "direct", id: "target-session-a" },
        sender,
      )).resolves.toMatchObject({ endpoint: { sessionId: "target-session-a", runId: target.runId } });
      await expect(resolver.resolve(
        {
          relationship: "direct",
          endpoint: {
            workspaceId: "local-workspace",
            sessionId: "target-session-b",
            runId: target.runId,
            laneId: "main",
          },
        },
        sender,
      )).resolves.toMatchObject({ endpoint: { sessionId: "target-session-b", runId: target.runId } });

      const tool = await createCrossRunRuntimeTool(composition, senderContext);
      const ledgerPath = join(target.stateDir, "ledger.jsonl");
      const before = await readFile(ledgerPath, "utf8");
      for (const [id, code] of [
        [target.runId, "selector-ambiguous"],
        ["missing-session", "target-unavailable"],
      ] as const) {
        const result = await tool.execute({
          target: { relationship: "direct", id },
          text: "must not reach either session",
        }, { runId: source.runId, workspace: root, operationId: `invalid:${id}` });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({ error: { code } });
      }
      expect(await readFile(ledgerPath, "utf8")).toBe(before);

      const request = {
        target: { relationship: "direct", id: "target-session-b" },
        text: "hello to session B",
      };
      const context = { runId: source.runId, workspace: root, operationId: "session-b-message" };
      const result = await tool.execute(request, context);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({
        status: "queued",
        target: { sessionId: "target-session-b", runId: target.runId, laneId: "nausicaa" },
      });
      expect((await tool.execute(request, context)).isError).toBe(false);
      const events = (await readFile(ledgerPath, "utf8")).trim().split("\n")
        .map((line): AnyEvent => JSON.parse(line));
      const messages = events.filter((event) => event.type === "message.sent");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.message).toMatchObject({
        targetEndpoint: { sessionId: "target-session-b", runId: target.runId, laneId: "main" },
        payload: { type: "message.inform", text: "hello to session B" },
      });
    } finally {
      await Promise.all([sessionA.close(), sessionB.close()]);
    }
  });

  it.each(["runId", "sessionId"] as const)("delivers once by %s while the idle target Session owns its Ledger lock", async (selectorField) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-live-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");

    const target = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Keep this Run open for a live recipient",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "partial",
        stopReason: "stop",
        toolCalls: [],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "live-target-run",
    });
    expect(target.completed).toBe(true);

    const targetModel = new ScriptedModel([{
      content: "received by target Main",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    }]);
    const targetSession = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      runId: target.runId,
      sessionId: "live-target-session",
    }, {
      mainModel: targetModel,
    });
    let received = 0;
    targetSession.subscribe((runtimeEvent) => {
      if (runtimeEvent.kind !== "event" || runtimeEvent.event.type !== "message.sent") return;
      if (runtimeEvent.event.payload.message.payload.type !== "message.inform") return;
      if (runtimeEvent.event.payload.message.payload.text !== "hello while live") return;
      received += 1;
    });

    try {
      const sourceModel = new ScriptedModel([
        {
          content: "send",
          stopReason: "toolUse",
          toolCalls: [{
            id: "source-live-message",
            name: "agent_message",
            arguments: {
              target: {
                relationship: "direct",
                id: selectorField === "runId" ? target.runId : "live-target-session",
              },
              payload: { type: "message.inform", text: "hello while live" },
            },
          }],
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        {
          content: "sent",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      const source = await executeRun({
        workspace: root,
        dataDir,
        model: "scripted",
        message: "Send to the live session",
        policy: { maxMainSteps: 2, tetoEnabled: false },
      }, {
        mainModel: sourceModel,
        createRunId: () => "live-source-run",
        crossRun: createLocalCrossRunComposition({ workspace: root, dataDir }),
      });
      expect(source).toMatchObject({ completed: true, finalText: "sent" });
      const receipt = sourceModel.requests[1]?.messages.findLast((message) => (
        message.role === "tool" && message.toolName === "agent_message"
      ));
      expect(JSON.parse(receipt?.content ?? "null")).toMatchObject({
        status: "queued",
        target: { sessionId: "live-target-session", runId: target.runId, laneId: "nausicaa" },
      });
      await waitFor(() => targetModel.callCount === 1);
      await targetSession.waitForIdle();
      expect(received).toBe(1);
      expect(targetModel.requests).toHaveLength(1);
      expect(targetModel.requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("hello while live"),
      });
      expect(targetSession.snapshot().pendingInputs).toBe(0);
    } finally {
      await targetSession.close();
    }
  });

  it("withdraws a closed Session before A2A target resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-local-a2a-offline-"));
    roots.push(root);
    const dataDir = join(root, ".nausicaa");

    const target = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Seed the offline target",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "seed partial",
        stopReason: "toolUse",
        toolCalls: [{ id: "offline-seed-noop", name: "noop", arguments: {} }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "offline-target-run",
    });
    expect(target.completed).toBe(false);

    const targetModel = new ScriptedModel([]);
    const targetSession = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      runId: target.runId,
      sessionId: "closed-target-session",
    }, { mainModel: targetModel });
    await targetSession.close();

    const sourceModel = new ScriptedModel([
      {
        content: "send",
        stopReason: "toolUse",
        toolCalls: [{
          id: "offline-source-message",
          name: "agent_message",
          arguments: {
            target: { relationship: "direct", id: target.runId },
            payload: { type: "message.inform", text: "delivered after reopen" },
          },
        }],
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
      (request) => {
        const result = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "agent_message"
        ));
        expect(result?.content).toContain('"code":"target-unavailable"');
        return {
          content: "not sent",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    ]);
    const source = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Send after target closed",
      policy: { maxMainSteps: 2, tetoEnabled: false },
    }, {
      mainModel: sourceModel,
      createRunId: () => "offline-source-run",
      crossRun: createLocalCrossRunComposition({ workspace: root, dataDir }),
    });
    expect(source).toMatchObject({ completed: true, finalText: "not sent" });
    const targetLedger = await readFile(
      join(root, ".nausicaa", "runs", target.runId, "ledger.jsonl"),
      "utf8",
    );
    expect(targetLedger).not.toContain("delivered after reopen");
  });
});

const noopTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object" as const, additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function reply(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } };
}

async function sendNote(workspace: string, dataDir: string, id: string, text: string): Promise<unknown> {
  const model = new ScriptedModel([{
    ...reply("send"), stopReason: "toolUse",
    toolCalls: [{ id: "send-note", name: "agent_message", arguments: {
      target: { relationship: "direct", id }, payload: { type: "message.inform", text },
    } }],
  }, reply("submitted")]);
  await executeRun({ workspace, dataDir, model: "scripted", message: "Send the note",
    policy: { tetoEnabled: false, maxMainSteps: 2 },
  }, { mainModel: model, createRunId: () => "note-source-run", crossRun: createLocalCrossRunComposition({ workspace, dataDir }) });
  const result = model.requests[1]?.messages.findLast((message) => message.role === "tool" && message.toolName === "agent_message");
  return JSON.parse(result?.content ?? "null");
}

async function readEvents(dataDir: string, runId: string): Promise<AnyEvent[]> {
  return (await readFile(join(dataDir, "runs", runId, "ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}
