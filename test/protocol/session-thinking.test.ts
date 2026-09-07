import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent, ModelPort, ModelResponse, ThinkingLevel } from "../../src/domain/index.js";
import { projectRun } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/index.js";

const roots: string[] = [];
const sessions: SessionController[] = [];
const levels: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function response(content = "done"): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } };
}

function withThinking(model: ScriptedModel): ModelPort {
  return {
    capabilities: (selector) => ({ imageInput: false, thinkingLevels: selector === "demo:plain" ? ["off"] : levels }),
    complete: model.complete.bind(model),
    stream: model.stream.bind(model),
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "nausicaa-thinking-"));
  roots.push(value);
  return value;
}

async function open(workspace: string, model: ModelPort, runId?: string): Promise<SessionController> {
  const session = await SessionController.open({
    workspace,
    dataDir: join(workspace, "state"),
    model: "demo:reasoning",
    ...(runId === undefined ? {} : { runId }),
    policy: { tetoEnabled: false, workerEnabled: false, maxModelTokens: 20_000, maxMainStepsPerActivation: 4 },
  }, {
    mainModel: model,
    createRunId: () => "thinking-run",
    tools: [{ definition: { name: "noop", description: "No operation", parameters: { type: "object" } }, execute: async () => ({ content: "done", isError: false }) }],
  });
  sessions.push(session);
  return session;
}

async function turn(session: SessionController, inputId = "input"): Promise<void> {
  await session.submit({ inputId, text: "Please continue" });
  await session.waitForIdle();
}

describe("session thinking preferences", () => {
  it("keeps the provider default unset and rejects unsupported explicit levels", async () => {
    const model = new ScriptedModel([response()]);
    const session = await open(await root(), withThinking(model));
    expect(session.thinkingLevel).toBeUndefined();
    expect(session.getAvailableThinkingLevels()).toEqual(levels);
    expect(session.getAvailableThinkingLevels()).not.toBe(levels);
    await expect(session.setThinkingLevel("max")).rejects.toThrow("not supported");
    await expect(session.setThinkingLevel("invalid" as ThinkingLevel)).rejects.toThrow("not supported");
    await expect(session.setThinkingLevel(undefined)).resolves.toMatchObject({ changed: false });
    await turn(session);
    expect(model.requests[0]).not.toHaveProperty("thinkingLevel");
    const source = await session.portableSessionSource();
    expect(source.events.some((event) => event.type === "thinking.selected")).toBe(false);
  });

  it("persists a preference selected before the first Run and restores it on resume", async () => {
    const workspace = await root();
    const model = new ScriptedModel([response()]);
    const session = await open(workspace, withThinking(model));
    await expect(session.setThinkingLevel("high")).resolves.toMatchObject({
      level: "high", previousLevel: undefined, changed: true, activeRequestUnaffected: false,
    });
    await turn(session);
    expect(model.requests[0]?.thinkingLevel).toBe("high");
    expect(session.snapshot().thinkingLevel).toBe("high");
    const source = await session.portableSessionSource();
    expect(projectRun(source.events, source.runId).lanes.main?.thinkingLevel).toBe("high");
    await session.close();

    const resumedModel = new ScriptedModel([response()]);
    const resumed = await open(workspace, withThinking(resumedModel), source.runId);
    expect(resumed.thinkingLevel).toBe("high");
    await turn(resumed, "resume-input");
    expect(resumedModel.requests[0]?.thinkingLevel).toBe("high");
    await resumed.setThinkingLevel(undefined);
    const cleared = await resumed.portableSessionSource();
    expect(cleared.events.filter((event) => event.type === "thinking.selected").at(-1)?.payload)
      .toEqual({ level: null });
    await resumed.close();
    const defaultSession = await open(workspace, withThinking(new ScriptedModel([])), source.runId);
    expect(defaultSession.thinkingLevel).toBeUndefined();
  });

  it("leaves an in-flight request unchanged and applies the new level at the next request boundary", async () => {
    let started: (() => void) | undefined;
    const beginning = new Promise<void>((resolve) => { started = resolve; });
    let release: ((value: ModelResponse) => void) | undefined;
    const pending = new Promise<ModelResponse>((resolve) => { release = resolve; });
    const model = new ScriptedModel([() => { started?.(); return pending; }, response()]);
    const session = await open(await root(), withThinking(model));
    const observed: AnyEvent[] = [];
    session.subscribe((event) => { if (event.kind === "event") observed.push(event.event); });
    await session.setThinkingLevel("low");
    await session.submit({ inputId: "in-flight", text: "Take two steps" });
    await beginning;
    await expect(session.setThinkingLevel("high")).resolves.toMatchObject({
      changed: true, level: "high", previousLevel: "low", activeRequestUnaffected: true,
    });
    expect(model.requests[0]?.thinkingLevel).toBe("low");
    release?.({ ...response(), stopReason: "toolUse", toolCalls: [{ id: "noop-1", name: "noop", arguments: {} }] });
    await session.waitForIdle();
    expect(model.requests.map((request) => request.thinkingLevel)).toEqual(["low", "high"]);
    expect(observed.filter((event) => event.type === "model.requested")
      .map((event) => event.payload.thinkingLevel)).toEqual(["low", "high"]);
  });

  it("retains supported levels on a model switch and durably resets unsupported ones", async () => {
    const workspace = await root();
    const session = await open(workspace, withThinking(new ScriptedModel([response()])));
    await session.setThinkingLevel("high");
    await turn(session);
    await session.selectModel("demo:another-reasoning");
    expect(session.thinkingLevel).toBe("high");
    await session.selectModel("demo:plain");
    expect(session.thinkingLevel).toBeUndefined();
    expect(session.getAvailableThinkingLevels()).toEqual(["off"]);
    const source = await session.portableSessionSource();
    expect(source.events.filter((event) => event.type === "model.selected").map((event) => event.payload)).toEqual([
      { model: "demo:another-reasoning", thinkingLevel: "high" },
      { model: "demo:plain" },
    ]);
    expect(projectRun(source.events, source.runId).lanes.main?.thinkingLevel).toBeUndefined();
    await session.close();
    const resumed = await open(workspace, withThinking(new ScriptedModel([])), source.runId);
    expect(resumed.model).toBe("demo:plain");
    expect(resumed.thinkingLevel).toBeUndefined();
  });

  it("uses the default when a resumed model no longer advertises the saved level", async () => {
    const workspace = await root();
    const session = await open(workspace, withThinking(new ScriptedModel([response()])));
    await session.setThinkingLevel("high");
    await turn(session);
    const runId = session.snapshot().runId!;
    await session.close();
    const model = new ScriptedModel([response()]);
    const resumed = await open(workspace, {
      ...withThinking(model),
      capabilities: () => ({ imageInput: false, thinkingLevels: ["off"] }),
    }, runId);
    expect(resumed.thinkingLevel).toBeUndefined();
    await turn(resumed, "catalog-changed");
    expect(model.requests[0]).not.toHaveProperty("thinkingLevel");
  });

  it("does not invent supported strengths for custom models without capability metadata", async () => {
    const session = await open(await root(), new ScriptedModel([]));
    expect(session.getAvailableThinkingLevels()).toEqual([]);
    await expect(session.setThinkingLevel("low")).rejects.toThrow("not supported");
    await expect(session.setThinkingLevel(undefined)).resolves.toMatchObject({ changed: false });
  });

  it("does not publish a new thinking value if the durable write fails", async () => {
    const workspace = await root();
    let denyWrites = false;
    const session = await SessionController.open({
      workspace,
      dataDir: join(workspace, "state"),
      model: "demo:reasoning",
      policy: { tetoEnabled: false, workerEnabled: false, maxModelTokens: 20_000 },
    }, {
      mainModel: withThinking(new ScriptedModel([response()])),
      createRunId: () => "thinking-write-failure",
      assertExecutionLease: () => { if (denyWrites) throw new Error("lease revoked"); },
    });
    sessions.push(session);
    await session.setThinkingLevel("high");
    await turn(session);
    denyWrites = true;
    try {
      await expect(session.setThinkingLevel("low")).rejects.toThrow("lease revoked");
      expect(session.thinkingLevel).toBe("high");
      expect(session.snapshot().thinkingLevel).toBe("high");
    } finally {
      denyWrites = false;
    }
  });

  it("forks the thinking preference from the selected historical checkpoint", async () => {
    const session = await open(await root(), withThinking(new ScriptedModel([response("first"), response("second")])));
    await session.setThinkingLevel("high");
    await turn(session, "first");
    const source = await session.portableSessionSource();
    const checkpoint = source.events.find((event) => event.type === "checkpoint.committed");
    if (checkpoint?.type !== "checkpoint.committed") throw new Error("Missing checkpoint");
    await session.setThinkingLevel("low");
    await turn(session, "second");
    await session.forkRun({ runId: "thinking-child", checkpoint: checkpoint.payload });
    expect(session.thinkingLevel).toBe("high");
    const fork = await session.portableSessionSource();
    expect(projectRun(fork.events, fork.runId).lanes.main?.thinkingLevel).toBe("high");
  });
});
