import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse, UserImage } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import { FileContentAddressedStore } from "../../src/store/index.js";

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
        imageTypes: ["image/png"],
        sequence: 2,
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
        maxModelTokens: 30,
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
    // charge. The unrelated 6,000-token Teto charge must not consume Main's 30.
    expect(resumedModel.requests[0]?.maxOutputTokens).toBe(10);
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
