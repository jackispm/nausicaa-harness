import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("SessionController", () => {
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
    await session.close();
  });

  it("delivers busy steering at the next safe Main boundary", async () => {
    const root = await temporaryRoot();
    let releaseFirst: ((value: ModelResponse) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const model = new ScriptedModel([
      () => new Promise<ModelResponse>((resolve) => {
        releaseFirst = resolve;
        markStarted?.();
      }),
      (request) => {
        expect(request.messages.some((message) =>
          message.role === "user"
          && message.content.includes("Use package.json instead"),
        )).toBe(true);
        return response("steered answer");
      },
    ]);
    const events: SessionRuntimeEvent[] = [];
    const session = await openSession(root, model, "steering-run", [noopTool]);
    session.subscribe((event) => events.push(event));

    const first = await session.submit({ inputId: "input-main", text: "Inspect setup" });
    await started;
    const steering = await session.submit({
      inputId: "input-steer",
      text: "Use package.json instead",
      delivery: "steering",
    });
    expect(steering.turnId).toBe(first.turnId);
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
    await session.close();
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

  it("does not resume past an unresolved tool outcome", async () => {
    const root = await temporaryRoot();
    const session = await openSession(root, new ScriptedModel([response("done")]), "unknown-resume");
    await session.submit({ inputId: "unknown-input", text: "Finish" });
    await session.waitForIdle();
    const runId = session.snapshot().runId!;
    await session.close();

    const ledger = await JsonlLedger.open(join(root, "state", "runs", runId, "ledger.jsonl"));
    const events = await ledger.read({ runId });
    const turnId = events.find((event) => event.type === "turn.started")?.payload.turnId;
    if (turnId === undefined) throw new Error("missing test Turn");
    await ledger.append({
      runId,
      turnId,
      laneId: "main",
      type: "tool.unknown",
      payload: {
        operationId: "unknown-op",
        toolCallId: "unknown-call",
        name: "write_file",
        reason: "provider response was lost",
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: "test:unknown-op",
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
      idempotencyKey: "test:unknown-waiting",
      visibility: "run",
    });
    await ledger.close();

    const resumed = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      runId,
    });
    await expect(resumed.resumeCurrent()).rejects.toThrow("Resolve unknown-op");
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

function durableEvents(events: readonly SessionRuntimeEvent[]) {
  return events
    .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => (
      event.kind === "event"
    ))
    .map((event) => event.event);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-session-"));
  roots.push(root);
  return root;
}
