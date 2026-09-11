import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import { createCrossRunRuntimeTool } from "../../src/runtime/cross-run-runtime.js";
import { createLocalCrossRunComposition } from "../../src/runtime/local-cross-run-composition.js";
import { executeRun } from "../../src/runtime/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { LocalSessionRegistry } from "../../src/runtime/local-session-registry.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";
import { MemoryLedger } from "../../src/ledger/memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local CLI Cross-Run composition", () => {
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
