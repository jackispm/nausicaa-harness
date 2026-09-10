import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  AgentTool,
  AppendEvent,
  EventType,
  Goal,
  ModelPort,
  ModelRequest,
  ModelResponse,
  RunPolicy,
} from "../../src/domain/index.js";
import { MemoryLedger, type Ledger } from "../../src/ledger/index.js";
import {
  RunTokenBudget,
  TeamRuntime,
  TetoLaneController,
} from "../../src/runtime/index.js";
import type { AgentTopologySnapshot } from "../../src/runtime/agent-awareness.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Build the requested app",
  successCriteria: ["The app is runnable"],
  hardConstraints: ["Do not expose private tool output"],
};

const policy: RunPolicy = {
  maxMainStepsPerActivation: 2,
  maxModelTokens: 10_000,
  mainRequestTimeoutMs: 10_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 64,
  tetoTokenRatio: 0.1,
  tetoActivation: "manual",
  workerEnabled: false,
};

const clock = {
  now: () => new Date("2026-09-03T00:00:00.000Z"),
};

describe("Teto and Team lane architecture", () => {
  it("keeps manual Teto dormant, starts it once, and projects only Main's public surface", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const model = new RecordingModel(() => response("Teto thought"));
    const runId = "manual-teto-run";

    const userRef = await store.put(JSON.stringify({
      role: "user",
      content: "Build the app",
      createdAt: clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    const assistantRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "I will inspect the entry point",
      toolCalls: [{
        id: "main-call-1",
        name: "read_file",
        arguments: { path: "src/app.ts" },
      }],
      createdAt: clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    const argumentsRef = await store.put(
      JSON.stringify({ path: "src/app.ts" }),
      TOOL_ARGUMENTS_MEDIA_TYPE,
    );
    const resultRef = await store.put(JSON.stringify({
      role: "tool",
      content: "PRIVATE TOOL RESULT: secret implementation details",
      toolCallId: "main-call-1",
      toolName: "read_file",
      isError: false,
      createdAt: clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    await ledger.append({
      runId,
      laneId: "main",
      type: "user.message",
      payload: { messageRef: userRef },
      correlationId: runId,
      idempotencyKey: "main:user",
      visibility: "run",
    });
    await ledger.append({
      runId,
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: assistantRef },
      correlationId: runId,
      idempotencyKey: "main:assistant",
      visibility: "run",
    });
    await ledger.append({
      runId,
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "op-1",
        toolCallId: "main-call-1",
        name: "read_file",
        argumentsRef,
      },
      correlationId: runId,
      idempotencyKey: "main:tool:requested",
      visibility: "run",
    });
    await ledger.append({
      runId,
      laneId: "main",
      type: "tool.succeeded",
      payload: {
        operationId: "op-1",
        toolCallId: "main-call-1",
        name: "read_file",
        resultRef,
      },
      correlationId: runId,
      idempotencyKey: "main:tool:succeeded",
      visibility: "run",
    });

    const controller = new TetoLaneController({
      eventSink: ledger,
      inbox,
      store,
      model,
      modelName: "scripted-teto",
      runId,
      goal,
      policy,
      workspace: "/workspace",
      readEvents: () => ledger.read({ runId }),
      readWatermark: () => ledger.watermark(),
      clock,
    });
    await controller.ensureAvailable();
    expect(controller.status(context(runId, "main"))).toMatchObject({
      active: false,
      available: true,
      laneId: "teto",
    });
    expect(model.callCount).toBe(0);

    const started = await controller.start(context(runId, "main"));
    const duplicate = await controller.start(context(runId, "main"));
    await controller.drain();


    expect(started).toMatchObject({ active: true, changed: true, laneId: "teto" });
    expect(duplicate).toMatchObject({ active: true, changed: false, laneId: "teto" });
    expect(model.callCount).toBe(2);
    const tetoText = model.requests
      .flatMap((request) => request.messages.map((message) => message.content))
      .join("\n");
    expect(tetoText).toContain("Build the app");
    expect(tetoText).toContain("read_file");
    expect(tetoText).not.toContain("PRIVATE TOOL RESULT");

    const events = await ledger.read({ runId });
    expect(events.filter((event) => event.type === "model.requested" && event.laneId === "teto")).toHaveLength(2);
    expect(events.filter((event) => event.type === "lane.registered" && event.laneId === "teto")).toHaveLength(1);
    // A process close does not write a user-requested stop control. A new
    // controller can therefore restore the intentionally active lane.
    await controller.close();
    const restored = new TetoLaneController({
      eventSink: ledger,
      inbox,
      store,
      model,
      modelName: "scripted-teto",
      runId,
      goal,
      policy,
      workspace: "/workspace",
      readEvents: () => ledger.read({ runId }),
      readWatermark: () => ledger.watermark(),
      clock,
    });
    expect(await restored.restoreIfRequested()).toBe(true);
    expect(restored.active).toBe(true);
    await restored.close();
  });

  it("auto-starts once, preserves an explicit stop across recovery, and allows reopening", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const model = new RecordingModel(() => response("Observed"));
    const runId = "automatic-teto-control";
    const controllers: TetoLaneController[] = [];
    const createController = () => {
      const controller = new TetoLaneController({
        eventSink: ledger, inbox, store, model, modelName: "scripted-teto", runId,
        goal, policy, workspace: "/workspace", clock, autoStart: true,
        readEvents: () => ledger.read({ runId }),
        readWatermark: () => ledger.watermark(),
      });
      controllers.push(controller);
      return controller;
    };
    try {
      const first = createController();
      expect(await Promise.all([first.restoreIfRequested(), first.restoreIfRequested()]))
        .toEqual([true, true]);
      expect(first.active).toBe(true);
      expect(model.callCount).toBe(0);
      expect(await first.stop(context(runId, "main"))).toMatchObject({ active: false, changed: true });

      const messageRef = await store.put(JSON.stringify({
        role: "user", content: "Observe the next task", createdAt: clock.now().toISOString(),
      }), MESSAGE_MEDIA_TYPE);
      const event = await ledger.append({
        runId, laneId: "main", type: "user.message", payload: { messageRef },
        correlationId: runId, idempotencyKey: "main:after-stop", visibility: "run",
      });
      first.observeMainEvent(event);
      await first.drain();
      expect(model.callCount).toBe(0);
      await first.close();

      const restored = createController();
      expect(await restored.restoreIfRequested()).toBe(false);
      expect(restored.active).toBe(false);
      await restored.drain();
      expect(model.callCount).toBe(0);
      expect(await restored.start(context(runId, "main"))).toMatchObject({ active: true, changed: true });
      await restored.drain();
      expect(model.callCount).toBe(1);
      const controls = (await ledger.read({ runId })).flatMap((item) => (
        item.type === "lane.status" && item.laneId === "teto" && item.payload.control !== undefined
          ? [item.payload.control.action] : []
      ));
      expect(controls).toEqual(["start", "stop", "start"]);
    } finally {
      await Promise.all(controllers.map((controller) => controller.close()));
    }
  });

  it("restores automatic Teto after host close without adding another start control", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const options = {
      eventSink: ledger, inbox, store: new MemoryContentAddressedStore(),
      model: new RecordingModel(() => response("Observed")), modelName: "scripted-teto",
      runId: "automatic-teto-host-close", goal, policy, workspace: "/workspace", clock,
      autoStart: true,
      readEvents: () => ledger.read({ runId: "automatic-teto-host-close" }),
      readWatermark: () => ledger.watermark(),
    };
    const first = new TetoLaneController(options);
    const restored = new TetoLaneController(options);
    try {
      expect(await first.restoreIfRequested()).toBe(true);
      await first.close();
      expect(await restored.restoreIfRequested()).toBe(true);
      expect(await restored.restoreIfRequested()).toBe(true);
      expect(restored.active).toBe(true);
      const controls = (await ledger.read({ runId: options.runId })).filter((event) => (
        event.type === "lane.status" && event.laneId === "teto" && event.payload.control !== undefined
      ));
      expect(controls).toHaveLength(1);
      expect(controls[0]?.payload).toMatchObject({ control: { action: "start", requestedBy: "main" } });
    } finally {
      await first.close();
      await restored.close();
    }
  });

  it("does not auto-start when policy disables Teto", async () => {
    const ledger = new MemoryLedger({ clock });
    const controller = new TetoLaneController({
      eventSink: ledger, inbox: new A2AInbox({ sink: ledger, clock }),
      store: new MemoryContentAddressedStore(), model: new RecordingModel(() => response("Observed")),
      modelName: "scripted-teto", runId: "disabled-automatic-teto", goal,
      policy: { ...policy, tetoEnabled: false }, workspace: "/workspace", clock, autoStart: true,
      readEvents: () => ledger.read(),
    });
    try {
      expect(await controller.restoreIfRequested()).toBe(false);
      expect(controller.available).toBe(false);
      expect(await ledger.read()).toEqual([]);
    } finally {
      await controller.close();
    }
  });

  it("rolls back Teto when the durable start status cannot be written", async () => {
    const ledger = new FailFirstTetoStartLedger();
    const inbox = new A2AInbox({ sink: ledger, clock });
    const controller = new TetoLaneController({
      eventSink: ledger,
      inbox,
      store: new MemoryContentAddressedStore(),
      model: new RecordingModel(() => response("silent")),
      modelName: "scripted-teto",
      runId: "teto-start-rollback",
      goal,
      policy,
      workspace: "/workspace",
      readEvents: () => ledger.read({ runId: "teto-start-rollback" }),
      readWatermark: () => ledger.watermark(),
      clock,
    });

    await controller.ensureAvailable();
    await expect(controller.start(context("teto-start-rollback", "main"))).rejects.toThrow(
      /injected Teto start failure/u,
    );
    expect(controller.active).toBe(false);
    await expect(controller.start(context("teto-start-rollback", "main"))).resolves.toMatchObject({
      active: true,
      changed: true,
    });
    await controller.close();
  });

  it("retries automatic startup when persisting its start control fails", async () => {
    const ledger = new FailFirstTetoStartLedger();
    const controller = new TetoLaneController({
      eventSink: ledger, inbox: new A2AInbox({ sink: ledger, clock }),
      store: new MemoryContentAddressedStore(), model: new RecordingModel(() => response("Observed")),
      modelName: "scripted-teto", runId: "automatic-teto-start-rollback", goal, policy,
      workspace: "/workspace", clock, autoStart: true,
      readEvents: () => ledger.read({ runId: "automatic-teto-start-rollback" }),
      readWatermark: () => ledger.watermark(),
    });
    try {
      await expect(controller.restoreIfRequested()).rejects.toThrow(/injected Teto start failure/u);
      expect(controller.active).toBe(false);
      expect(await controller.restoreIfRequested()).toBe(true);
      expect(controller.active).toBe(true);
    } finally {
      await controller.close();
    }
  });

  it("keeps Teto active after a rejected stop and preserves the successful retry on recovery", async () => {
    const ledger = new FailFirstTetoStopLedger();
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const model = new RecordingModel(() => response("Still observing"));
    const runId = "teto-stop-retry";
    const options = {
      eventSink: ledger, inbox, store, model, modelName: "scripted-teto", runId,
      goal, policy, workspace: "/workspace", clock, autoStart: true,
      readEvents: () => ledger.read({ runId }),
      readWatermark: () => ledger.watermark(),
    };
    const controller = new TetoLaneController(options);
    const restored = new TetoLaneController(options);
    try {
      expect(await controller.restoreIfRequested()).toBe(true);
      await expect(controller.stop(context(runId, "main")))
        .rejects.toThrow("injected Teto stop failure");
      expect(controller.active).toBe(true);
      expect((await ledger.read({ runId })).some((event) => (
        event.type === "lane.status" && event.payload.control?.action === "stop"
      ))).toBe(false);

      const messageRef = await store.put(JSON.stringify({
        role: "user", content: "The rejected stop did not disable observation", createdAt: clock.now().toISOString(),
      }), MESSAGE_MEDIA_TYPE);
      controller.observeMainEvent(await ledger.append({
        runId, laneId: "main", type: "user.message", payload: { messageRef },
        correlationId: runId, idempotencyKey: "main:after-stop-failure", visibility: "run",
      }));
      await controller.drain();
      expect(model.callCount).toBe(1);

      expect(await controller.stop(context(runId, "main")))
        .toMatchObject({ active: false, changed: true });
      expect(await controller.stop(context(runId, "main")))
        .toMatchObject({ active: false, changed: false });
      await controller.close();
      expect(await restored.restoreIfRequested()).toBe(false);
      expect(restored.active).toBe(false);
      const controls = (await ledger.read({ runId })).flatMap((event) => (
        event.type === "lane.status" && event.laneId === "teto" && event.payload.control !== undefined
          ? [event.payload.control.action] : []
      ));
      expect(controls).toEqual(["start", "stop"]);
    } finally {
      await controller.close();
      await restored.close();
    }
  });

  it("runs a Team branch as an ordinary lane with its own optional Teto and returns a later-boundary result", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const parentBudget = new RunTokenBudget(100_000);
    const model = new BranchAndTetoModel();
    const team = new TeamRuntime({
      eventSink: ledger,
      inbox,
      store,
      model,
      modelName: "scripted-team",
      runId: "team-run",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: parentBudget,
      readEvents: () => ledger.read({ runId: "team-run" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      clock,
    });

    const created = await team.create({
      teamId: "app-build",
      branches: [
        {
          branchId: "frontend",
          statement: "Build the frontend slice",
          maxModelTokens: 5_000,
          maxWallClockMs: 10_000,
          maxAttempts: 2,
        },
        {
          branchId: "backend",
          statement: "Build the backend slice",
          maxModelTokens: 5_000,
          maxWallClockMs: 10_000,
          maxAttempts: 2,
        },
      ],
    }, context("team-run", "main"));
    expect(created.branches).toEqual([
      { branchId: "frontend", laneId: "team:app-build:frontend", status: "queued" },
      { branchId: "backend", laneId: "team:app-build:backend", status: "queued" },
    ]);

    await team.drain();
    const boundary = await team.beforeMainStep({ step: 2 });
    expect(boundary.filter((message) => message.source.startsWith("team:") && message.content.includes("branch done"))).toHaveLength(2);
    expect(boundary.some((message) => message.content.includes("Team app-build joined"))).toBe(true);

    const events = await ledger.read({ runId: "team-run" });
    for (const laneId of ["team:app-build:frontend", "team:app-build:backend"]) {
      expect(events.some((event) => event.type === "lane.registered" && event.laneId === laneId)).toBe(true);
      expect(events.some((event) => event.type === "lane.registered" && event.laneId === `${laneId}:teto`)).toBe(true);
      expect(model.requests.some((request) => request.laneId === `${laneId}:teto`)).toBe(true);
    }
    const results = inbox.snapshot().records.filter((record) => (
      record.message.payload.type === "task.result"
    ));
    expect(results).toHaveLength(2);
    expect(results.every((record) => record.message.to === "main")).toBe(true);
    expect(parentBudget.snapshot().usedTokens).toBeGreaterThan(0);
    await team.stop();
  });

  it("recovers a committed Team terminal without re-running the branch", async () => {
    let nowMs = Date.parse("2026-09-03T00:00:00.000Z");
    const recoveryClock = { now: () => new Date(nowMs) };
    const ledger = new FailFirstBranchHandleLedger("team:recovery:branch", recoveryClock);
    const inbox = new A2AInbox({ sink: ledger, clock: recoveryClock, claimLeaseMs: 1_000 });
    const store = new MemoryContentAddressedStore();
    const model = new BranchAndTetoModel();
    const options = {
      eventSink: ledger,
      store,
      model,
      modelName: "scripted-team",
      runId: "recovery-team",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: new RunTokenBudget(100_000),
      readEvents: () => ledger.read({ runId: "recovery-team" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      clock: recoveryClock,
    } as const;
    const team = new TeamRuntime({ ...options, inbox });
    await team.create({
      teamId: "recovery",
      branches: [{ branchId: "branch", statement: "Recover this branch" }],
    }, context("recovery-team", "main"));
    await team.drain();

    const firstRunRequestCount = model.requests.filter((request) => request.laneId === "team:recovery:branch").length;
    expect(firstRunRequestCount).toBe(2);
    expect(inbox.snapshot().records.filter((record) => record.message.payload.type === "task.result")).toHaveLength(1);
    expect(inbox.snapshot().records.filter((record) => record.message.payload.type === "task.failed")).toHaveLength(0);
    await team.stop();

    nowMs += 2_000;
    const recoveredInbox = A2AInbox.rehydrate(await ledger.read({ runId: "recovery-team" }), {
      sink: ledger,
      clock: recoveryClock,
      claimLeaseMs: 1_000,
    });
    const recoveredTeam = new TeamRuntime({ ...options, inbox: recoveredInbox });
    await recoveredTeam.restore();
    await recoveredTeam.drain();
    expect(model.requests.filter((request) => request.laneId === "team:recovery:branch")).toHaveLength(firstRunRequestCount);
    expect(recoveredInbox.snapshot().records.find((record) => record.message.payload.type === "task.request")?.status).toBe("handled");
    await recoveredTeam.stop();
  });

  it("resumes a Team after a later branch admission fails", async () => {
    const ledger = new FlakyTeamLedger("team:partial:backend");
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const team = new TeamRuntime({
      eventSink: ledger,
      inbox,
      store,
      model: new BranchAndTetoModel(),
      modelName: "scripted-team",
      runId: "partial-team",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: new RunTokenBudget(100_000),
      readEvents: () => ledger.read({ runId: "partial-team" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      clock,
    });
    const request = {
      teamId: "partial",
      branches: [
        { branchId: "frontend", statement: "Build frontend" },
        { branchId: "backend", statement: "Build backend" },
      ],
    };

    await expect(team.create(request, context("partial-team", "main"))).rejects.toThrow(/injected team admission failure/u);
    await team.drain();
    const resumed = await team.create(request, context("partial-team", "main"));

    expect(resumed.branches).toEqual([
      { branchId: "frontend", laneId: "team:partial:frontend", status: "duplicate" },
      { branchId: "backend", laneId: "team:partial:backend", status: "queued" },
    ]);
    await team.drain();
    const events = await ledger.read({ runId: "partial-team" });
    expect(events.filter((event) => (
      event.type === "lane.registered"
      && event.payload.kind === "team"
    ))).toHaveLength(2);
    expect(inbox.snapshot().records.filter((record) => (
      record.message.payload.type === "task.result"
    ))).toHaveLength(2);
    await team.stop();
  });

  it("reconstructs a partially admitted Team after a process restart", async () => {
    const ledger = new FlakyTeamLedger("team:restart-partial:backend");
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const model = new BranchAndTetoModel();
    const options = {
      eventSink: ledger,
      store,
      model,
      modelName: "scripted-team",
      runId: "restart-partial-team",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: new RunTokenBudget(100_000),
      readEvents: () => ledger.read({ runId: "restart-partial-team" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      clock,
    } as const;
    const request = {
      teamId: "restart-partial",
      branches: [
        { branchId: "frontend", statement: "Build frontend" },
        { branchId: "backend", statement: "Build backend" },
      ],
    };
    const team = new TeamRuntime({ ...options, inbox });

    await expect(team.create(request, context("restart-partial-team", "main"))).rejects.toThrow(
      /injected team admission failure/u,
    );
    await team.drain();
    await team.stop();

    const recoveredInbox = A2AInbox.rehydrate(await ledger.read({ runId: "restart-partial-team" }), {
      sink: ledger,
      clock,
    });
    const recoveredTeam = new TeamRuntime({ ...options, inbox: recoveredInbox });
    await recoveredTeam.restore();
    const resumed = await recoveredTeam.create(request, context("restart-partial-team", "main"));

    expect(resumed.branches).toEqual([
      { branchId: "backend", laneId: "team:restart-partial:backend", status: "queued" },
      { branchId: "frontend", laneId: "team:restart-partial:frontend", status: "duplicate" },
    ]);
    await recoveredTeam.drain();
    expect(recoveredInbox.snapshot().records.filter((record) => (
      record.message.payload.type === "task.result"
    ))).toHaveLength(2);
    await recoveredTeam.stop();
  });

  it("enforces the subagent depth limit before admitting Team branches", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const team = new TeamRuntime({
      eventSink: ledger,
      inbox,
      store,
      model: new BranchAndTetoModel(),
      modelName: "scripted-team",
      runId: "depth-limited-team",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: new RunTokenBudget(100_000),
      readEvents: () => ledger.read({ runId: "depth-limited-team" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      depth: 1,
      maxDepth: 1,
      clock,
    });

    await expect(team.create({
      teamId: "nested",
      branches: [{ branchId: "child", statement: "Must be denied" }],
    }, context("depth-limited-team", "main"))).rejects.toThrow(/recursion depth limit/i);
    expect(inbox.snapshot().records).toEqual([]);
    expect(await ledger.read({ runId: "depth-limited-team" })).toEqual([]);
    await team.stop();
  });

  it("normalizes Team branch names before creating lane identities", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const team = new TeamRuntime({
      eventSink: ledger,
      inbox,
      store,
      model: new BranchAndTetoModel(),
      modelName: "scripted-team",
      runId: "normalized-team",
      workspace: "/workspace",
      branchTools: [noopTool],
      runTokenBudget: new RunTokenBudget(100_000),
      readEvents: () => ledger.read({ runId: "normalized-team" }),
      readWatermark: () => ledger.watermark(),
      readAwareness: () => emptyAwareness(),
      policy,
      createId: () => "child-a1b2c3d4",
      clock,
    });

    const created = await team.create({
      teamId: "names",
      branches: [
        { branchId: "Feature/API v2", statement: "Inspect naming" },
        { statement: "Inspect generated naming" },
      ],
    }, context("normalized-team", "main"));
    expect(created.branches[0]).toMatchObject({
      branchId: "feature-api-v2",
      laneId: "team:names:feature-api-v2",
    });
    expect(created.members?.[1]).toMatchObject({ memberId: "worker-1", name: "worker 1", laneId: "team:names:worker-1" });
    await team.stop();
  });

  it("settles child lane reservations into the parent aggregate budget", () => {
    const parent = new RunTokenBudget(100);
    const child = new RunTokenBudget(80, 0, { parent, scope: "team:branch" });

    expect(child.reserve("step-1", 40)).toBeDefined();
    expect(parent.availableTokens()).toBe(60);
    child.settle("step-1", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(child.snapshot().usedTokens).toBe(18);
    expect(parent.snapshot().usedTokens).toBe(18);
    expect(parent.availableTokens()).toBe(82);
  });

  it("keeps a branch Teto child inside the branch and Run aggregate budgets", () => {
    const runBudget = new RunTokenBudget(100);
    const branchBudget = new RunTokenBudget(80, 0, {
      parent: runBudget,
      scope: "team:branch",
    });
    const tetoBudget = new RunTokenBudget(80, 0, {
      parent: branchBudget,
      scope: "team:branch:teto",
    });

    expect(branchBudget.reserve("main-step", 70)).toBeDefined();
    expect(tetoBudget.reserve("observer-step", 20)).toBeUndefined();
    expect(runBudget.availableTokens()).toBe(30);
    branchBudget.cancel("main-step");
    expect(tetoBudget.reserve("observer-step", 20)).toBeDefined();
    tetoBudget.settle("observer-step", 12);
    expect(branchBudget.snapshot().usedTokens).toBe(12);
    expect(runBudget.snapshot().usedTokens).toBe(12);
  });
});

class RecordingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responder: (request: ModelRequest) => ModelResponse) {}

  get callCount(): number {
    return this.requests.length;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, ...observable } = request;
    this.requests.push(structuredClone(observable));
    return structuredClone(this.responder(request));
  }
}

class BranchAndTetoModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly branchCalls = new Map<string, number>();

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, ...observable } = request;
    this.requests.push(structuredClone(observable));
    if (request.laneId?.endsWith(":teto")) return response("Teto voice");
    const laneId = request.laneId ?? "unknown";
    const calls = (this.branchCalls.get(laneId) ?? 0) + 1;
    this.branchCalls.set(laneId, calls);
    if (calls === 1) {
      return {
        ...response("opening Teto"),
        stopReason: "toolUse",
        toolCalls: [{ id: "branch-start-teto", name: "teto_start", arguments: {} }],
      };
    }
    return response(`branch done (${laneId})`);
  }
}

class FlakyTeamLedger extends MemoryLedger {
  private readonly failingLaneId: string;
  private failed = false;

  constructor(failingLaneId: string) {
    super({ clock });
    this.failingLaneId = failingLaneId;
  }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "lane.registered" && input.laneId === this.failingLaneId) {
      this.failed = true;
      throw new Error("injected team admission failure");
    }
    return super.append(input);
  }
}

class FailFirstTetoStartLedger extends MemoryLedger {
  private failed = false;

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (
      !this.failed
      && input.type === "lane.status"
      && "control" in input.payload
      && input.payload.control?.action === "start"
    ) {
      this.failed = true;
      throw new Error("injected Teto start failure");
    }
    return super.append(input);
  }
}

class FailFirstTetoStopLedger extends MemoryLedger {
  private failed = false;

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "lane.status"
      && "control" in input.payload && input.payload.control?.action === "stop") {
      this.failed = true;
      throw new Error("injected Teto stop failure");
    }
    return super.append(input);
  }
}

class FailFirstBranchHandleLedger extends MemoryLedger {
  private failed = false;

  constructor(
    private readonly branchLaneId: string,
    clock: { now: () => Date },
  ) {
    super({ clock });
  }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "message.handled" && input.laneId === this.branchLaneId) {
      this.failed = true;
      throw new Error("injected branch acknowledgement failure");
    }
    return super.append(input);
  }
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

function context(runId: string, laneId: string) {
  return {
    runId,
    laneId,
    workspace: "/workspace",
    operationId: `${laneId}:operation`,
  };
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
  };
}

function emptyAwareness(): AgentTopologySnapshot {
  return {
    version: 1,
    generatedAt: clock.now().toISOString(),
    availability: "fresh",
    nodes: [],
    edges: [],
    roots: [],
    truncated: false,
  };
}

const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";
