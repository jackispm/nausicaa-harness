import { describe, expect, it } from "vitest";

import type { CrossRunRoster } from "../../src/a2a/cross-run-contract.js";
import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { TeamMemberDefinition } from "../../src/domain/team.js";
import type { A2AMessage, TaskRequest } from "../../src/domain/types.js";
import { MemoryLedger, projectRun } from "../../src/ledger/index.js";
import { projectAgentTopology } from "../../src/runtime/agent-awareness.js";
import { createScopedSpawnContext } from "../../src/runtime/lane-context.js";
import {
  composeAgentAwarenessProjectionInput,
  type AgentAwarenessCompositionOptions,
} from "../../src/runtime/agent-awareness-composition.js";
import type { DaemonWorkerDescriptor } from "../../src/runtime/daemon-worker-protocol.js";
import type { SessionSnapshot } from "../../src/runtime/session-controller.js";
import type { RunProjection } from "../../src/ledger/projection.js";

const now = "2026-09-01T12:00:00.000Z";

function event<K extends EventType>(
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId = "main",
): AppendEvent<K> {
  return {
    runId: "activation-run", laneId, type, payload,
    correlationId: "awareness-activation",
    idempotencyKey: `${laneId}:${type}:${JSON.stringify(payload)}`,
    occurredAt: now,
  };
}

function taskRequest(taskId = "task-1"): TaskRequest {
  return {
    type: "task.request", taskId,
    goal: { version: 1, statement: "Inspect the task", successCriteria: [], hardConstraints: [] },
    inputRefs: [], budget: { maxModelTokens: 1_000, maxWallClockMs: 5_000 },
  };
}

function message(payload: A2AMessage["payload"], to = "worker"): A2AMessage {
  return {
    messageId: `message:${payload.type}:${to}`, runId: "activation-run",
    conversationId: "activation-run", threadId: "activation-run", from: "main", to,
    createdAt: now, correlationId: "awareness-activation",
    idempotencyKey: `message:${payload.type}:${to}`,
    visibility: "run", priority: 0, delivery: "next-step", payload,
  };
}

function scopedTeamMessage(to: string, from: string): A2AMessage {
  const reducer = to.startsWith("team-reducer:");
  const task = taskRequest(reducer ? `team:${to.slice("team-reducer:".length)}:reduction` : to.slice("team:".length));
  const scope = { workspaceId: "repo", sessionId: "session-a", runId: "activation-run" };
  task.spawnContext = createScopedSpawnContext({
    parent: { ...scope, laneId: from, laneKind: from === "main" ? "main" : "team" },
    child: { ...scope, laneId: to, laneKind: reducer ? "worker" : "team", parentLaneId: from, ownerLaneId: from,
      relation: reducer ? "delegates" : "member-of" },
    goal: task.goal, inputRefs: task.inputRefs, budget: task.budget, role: "Team task lane",
  });
  return { ...message(task, to), from };
}

async function availableLanes(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.append(event("lane.registered", { kind: "main" }));
  await ledger.append(event("lane.registered", { kind: "intent-navigator" }, "teto"));
  await ledger.append(event("lane.status", { status: "dormant" }, "teto"));
  await ledger.append(event("lane.registered", { kind: "worker" }, "worker"));
  return ledger;
}

async function activationSnapshot(ledger: MemoryLedger) {
  return projectAgentTopology(composeAgentAwarenessProjectionInput({
    workspaceId: "repo", sessionId: "session-a", now,
    runs: [{ projection: projectRun(await ledger.read(), "activation-run") }],
  }));
}

function projection(
  runId: string,
  lanes: RunProjection["lanes"],
  status: RunProjection["run"]["status"] = "running",
): RunProjection {
  return {
    run: { runId, status, lastOffset: 4 },
    goal: undefined,
    lanes,
    inbox: [],
    inputs: [],
    turns: Object.create(null) as RunProjection["turns"],
    unknownOperations: [],
    budget: {
      charged: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      byLane: Object.create(null) as RunProjection["budget"]["byLane"],
    },
    conversation: [],
  };
}

function lane(
  laneId: string,
  status: "dormant" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled",
  kind: "main" | "intent-navigator" | "reflection" | "worker" = "main",
): RunProjection["lanes"][string] {
  return { laneId, status, kind, lastSeq: 1 };
}

function session(runId: string, status: SessionSnapshot["status"] = "running"): SessionSnapshot {
  return {
    workspace: "/private/should-never-be-an-endpoint",
    runId,
    status,
    model: "model:test",
    tetoEnabled: true,
    workerEnabled: true,
    permissionProfile: "workspace",
    collaborationMode: "default",
    allowWrite: true,
    allowShell: false,
    allowNetwork: false,
    workspaceBashAvailability: { available: false, reason: "test" },
    pendingInputs: 0,
    lastCommittedStep: 1,
    mainContextTokens: null,
    mainContextWindowTokens: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function descriptor(runId: string, fencingToken: number, publishedAt = now): DaemonWorkerDescriptor {
  return {
    version: 1,
    runId,
    workerId: `worker-${fencingToken}`,
    leasePath: "/private/lease/never-print",
    fencingToken,
    instanceToken: `instance-${fencingToken}`,
    publishedAt,
  };
}

describe("agent awareness runtime composition", () => {
  it("names generated status summaries Nausicaa while retaining canonical identities and task wording", () => {
    const snapshot = projectAgentTopology(composeAgentAwarenessProjectionInput({
      workspaceId: "repo", sessionId: "session-a", now,
      runs: [{
        projection: projection("working-run", { main: lane("main", "running") }),
        state: "active",
      }, {
        projection: projection("task-run", { main: lane("main", "running") }),
        activitySummary: "Inspect main.ts on the main branch",
      }],
      host: {
        status: "running", ownerId: "daemon-owner", queuedRuns: 1, runningRuns: 0, attachedClients: 1,
        runs: [{ runId: "queued-run", state: "queued", pendingWakeCount: 1 }],
      },
    }));

    expect(snapshot.nodes.find((node) => node.endpoint.runId === "working-run")).toMatchObject({
      endpoint: { laneId: "main" }, role: "main", activitySummary: "Nausicaa working",
    });
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "queued-run")).toMatchObject({
      endpoint: { laneId: "main" }, role: "main", activitySummary: "Nausicaa queued for wake",
    });
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "task-run")?.activitySummary)
      .toBe("Inspect main.ts on the main branch");
  });

  it("propagates build identity from the owning session or Run without copying it into other sessions", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo", sessionId: "session-a", now,
      runs: [{
        projection: projection("known-run", {
          main: lane("main", "ready"),
          teto: { ...lane("teto", "dormant", "intent-navigator"), activated: true },
        }),
        runtimeBuildId: "aaaaaaaaaaaa",
      }, {
        projection: projection("unknown-run", { main: lane("main", "ready") }),
        scope: { sessionId: "session-b" },
      }],
      sessions: [{ sessionId: "session-c", state: "idle", runtimeBuildId: "cccccccccccc" }],
    });
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes.filter((node) => node.endpoint.runId === "known-run")
      .map((node) => node.runtimeBuildId)).toEqual(["aaaaaaaaaaaa", "aaaaaaaaaaaa"]);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "unknown-run"))
      .not.toHaveProperty("runtimeBuildId");
    expect(snapshot.nodes.find((node) => node.endpoint.sessionId === "session-c")?.runtimeBuildId)
      .toBe("cccccccccccc");
  });

  it("does not carry an earlier process build identity into a newer generation without metadata", () => {
    const run = projection("replaced-run", { main: lane("main", "ready") });
    const sources = [
      { projection: run, generation: 1, runtimeBuildId: "aaaaaaaaaaaa" },
      { projection: run, generation: 2 },
    ];
    for (const runs of [sources, [...sources].reverse()]) {
      const snapshot = projectAgentTopology(composeAgentAwarenessProjectionInput({
        workspaceId: "repo", sessionId: "session-a", now, runs,
      }));
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]?.generation).toBe(2);
      expect(snapshot.nodes[0]).not.toHaveProperty("runtimeBuildId");
    }
  });

  it("does not turn registered capabilities or ordinary messages into agents", async () => {
    const ledger = await availableLanes();
    await ledger.append(event("model.selected", { model: "model:teto" }, "teto"));
    await ledger.append(event("message.sent", { message: message({ type: "message.inform", text: "Available" }) }));
    await ledger.append(event("message.sent", { message: {
      ...message({ type: "message.inform", text: "Available" }, "main"), from: "teto",
    } }, "teto"));
    await ledger.append(event("lane.status", {
      status: "waiting", control: { action: "stop", requestedBy: "main" },
    }, "teto"));
    await ledger.append(event("lane.status", { status: "cancelled", reason: "Never-started slot closed" }, "teto"));

    const snapshot = await activationSnapshot(ledger);
    expect(snapshot.nodes.map((node) => node.endpoint.laneId)).toEqual(["main"]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.roots).toHaveLength(1);
    const projected = projectRun(await ledger.read(), "activation-run");
    expect(projected.lanes.teto).toMatchObject({ activated: false });
    expect(projected.lanes.worker).toMatchObject({ activated: false });
  });

  it("keeps an explicitly started Teto before its first step and after it becomes idle", async () => {
    const ledger = await availableLanes();
    await ledger.append(event("lane.status", {
      status: "ready", control: { action: "start", requestedBy: "main" },
    }, "teto"));
    expect(projectRun(await ledger.read(), "activation-run").lanes.teto?.lastStep).toBeUndefined();
    expect((await activationSnapshot(ledger)).nodes.map((node) => [node.endpoint.laneId, node.state]))
      .toEqual([["main", "idle"], ["teto", "idle"]]);

    await ledger.append(event("lane.status", { status: "dormant", reason: "Observation finished" }, "teto"));
    const snapshot = await activationSnapshot(ledger);
    expect(snapshot.nodes.map((node) => node.endpoint.laneId)).toEqual(["main", "teto"]);
    expect(snapshot.edges.map((edge) => edge.relation).sort()).toEqual(["observer", "parent"]);
    const events = await ledger.read();
    expect(projectRun([...events].reverse(), "activation-run")).toEqual(projectRun(events, "activation-run"));
  });

  it("includes a queued Worker from durable task admission without needing a model step", async () => {
    const ledger = await availableLanes();
    await ledger.append(event("message.sent", { message: message(taskRequest()) }));
    expect(projectRun(await ledger.read(), "activation-run").lanes.worker)
      .toMatchObject({ activated: true, status: "ready" });
    expect(projectRun(await ledger.read(), "activation-run").lanes.worker?.lastStep).toBeUndefined();
    const snapshot = await activationSnapshot(ledger);
    expect(snapshot.nodes.map((node) => node.endpoint.laneId)).toEqual(["main", "worker"]);
    expect(snapshot.edges.map((edge) => edge.relation).sort()).toEqual(["delegates", "parent"]);

    await ledger.append(event("lane.status", { status: "dormant" }, "worker"));
    expect((await activationSnapshot(ledger)).nodes.find((node) => node.endpoint.laneId === "worker")?.state).toBe("idle");
  });

  it("does not activate local capability slots from routed or misattributed task messages", async () => {
    const ledger = await availableLanes();
    const remote = { workspaceId: "repo", sessionId: "other", runId: "remote", laneId: "worker" };
    const base = message(taskRequest());
    const prefix = await ledger.read();
    const admitted = await ledger.append(event("message.sent", { message: base }));
    for (const [index, changes] of [
      { targetEndpoint: remote },
      { routeId: "cross-run-route", sourceEndpoint: remote },
      { runId: "remote" },
      { from: "unrelated" },
    ].entries()) {
      const input = composeAgentAwarenessProjectionInput({
        workspaceId: "repo", sessionId: "session-a", now,
        runs: [{ projection: projectRun([...prefix, {
          ...admitted, payload: { message: {
            ...base, ...changes, messageId: `foreign-${index}`, idempotencyKey: `foreign-${index}`,
          } },
        }], "activation-run") }],
      });
      expect(projectAgentTopology(input).nodes.map((node) => node.endpoint.laneId)).toEqual(["main"]);
    }
  });

  it("includes queued Team dependencies and a requested reducer but not member Teto slots", async () => {
    const ledger = await availableLanes();
    const members: TeamMemberDefinition[] = ["a", "b"].map((memberId) => ({
      memberId, laneId: `team:review:${memberId}`, task: taskRequest(`review:${memberId}`),
      dependsOn: memberId === "b" ? ["a"] : [], required: true,
    }));
    await ledger.append(event("team.created", {
      teamId: "review", leadLaneId: "main", joinPolicy: "all-terminal", peerMessaging: "team-members",
      deadline: "2026-09-01T12:01:00.000Z", fingerprint: "review-fingerprint", members,
    }));
    for (const member of members) {
      await ledger.append(event("lane.registered", { kind: "team" }, member.laneId));
      await ledger.append(event("lane.registered", { kind: "intent-navigator" }, `${member.laneId}:teto`));
    }
    const reducer: TeamMemberDefinition = {
      memberId: "reducer", laneId: "team-reducer:review", task: taskRequest("review:reduction"),
      dependsOn: [], required: true,
    };
    await ledger.append(event("team.reduction.requested", { teamId: "review", reducer }));
    await ledger.append(event("lane.registered", { kind: "worker" }, reducer.laneId));

    expect((await activationSnapshot(ledger)).nodes.map((node) => node.endpoint.laneId))
      .toEqual(["main", "team-reducer:review", "team:review:a", "team:review:b"]);
    await ledger.append(event("lane.status", {
      status: "ready", control: { action: "start", requestedBy: "team:review:b" },
    }, "team:review:b:teto"));
    const snapshot = await activationSnapshot(ledger);
    expect(snapshot.nodes.map((node) => node.endpoint.laneId)).toContain("team:review:b:teto");
    expect(snapshot.nodes.map((node) => node.endpoint.laneId)).not.toContain("team:review:a:teto");
    const keys = new Set(snapshot.nodes.map((node) => node.key));
    expect(snapshot.edges.every((edge) => keys.has(edge.source) && keys.has(edge.target))).toBe(true);
    expect(snapshot.edges.filter((edge) => edge.relation === "observer")).toEqual([
      expect.objectContaining({
        source: snapshot.nodes.find((node) => node.endpoint.laneId === "team:review:b:teto")?.key,
        target: snapshot.nodes.find((node) => node.endpoint.laneId === "team:review:b")?.key,
      }),
    ]);
  });

  it("attaches nested Team members and reducers to their admitted lead while Teto follows its owner", async () => {
    const ledger = await availableLanes();
    const lead = "team:outer:worker-1";
    const member = "team:nested:reviewer";
    const reducer = "team-reducer:nested";
    for (const [laneId, parent] of [[lead, "main"], [member, lead], [reducer, lead]] as const) {
      await ledger.append(event("lane.registered", { kind: laneId === reducer ? "worker" : "team" }, laneId));
      await ledger.append(event("message.sent", { message: scopedTeamMessage(laneId, parent) }, parent));
    }
    const observer = `${member}:teto`;
    await ledger.append(event("lane.registered", { kind: "intent-navigator" }, observer));
    await ledger.append(event("lane.status", { status: "ready", control: { action: "start", requestedBy: member } }, observer));

    const snapshot = await activationSnapshot(ledger);
    const ids = new Map(snapshot.nodes.map((node) => [node.key, node.endpoint.laneId]));
    const edges = snapshot.edges.map((edge) => ({ source: ids.get(edge.source), target: ids.get(edge.target), relation: edge.relation }));
    expect(edges).toEqual(expect.arrayContaining([
      { source: "main", target: lead, relation: "parent" },
      { source: lead, target: member, relation: "parent" },
      { source: lead, target: reducer, relation: "parent" },
      { source: lead, target: reducer, relation: "delegates" },
      { source: member, target: observer, relation: "parent" },
      { source: observer, target: member, relation: "observer" },
    ]));
    expect(edges.some((edge) => edge.source === "main" && [member, reducer, observer].includes(edge.target ?? ""))).toBe(false);
  });

  it.each([
    "other-run", "routed", "unknown-parent", "missing-context", "foreign-workspace", "foreign-session", "wrong-task", "wrong-owner", "conflicting-parents",
  ])("keeps the fallback owner for a Team task with %s evidence", (problem) => {
    const lead = "team:outer:worker-1";
    const peer = "team:outer:worker-2";
    const member = "team:nested:reviewer";
    const run = projection("activation-run", {
      main: lane("main", "running"),
      [lead]: { ...lane(lead, "running"), kind: "team" },
      [peer]: { ...lane(peer, "running"), kind: "team" },
      [member]: { ...lane(member, "running"), kind: "team" },
    });
    const request = scopedTeamMessage(member, lead);
    if (request.payload.type !== "task.request") throw new Error("Expected a task fixture");
    const context = request.payload.spawnContext!;
    if (problem === "other-run") request.runId = "foreign-run";
    if (problem === "routed") request.routeId = "cross-run-route";
    if (problem === "unknown-parent") request.from = "team:unknown:lead";
    if (problem === "missing-context") delete request.payload.spawnContext;
    if (problem === "foreign-workspace") context.parent.workspaceId = context.child.workspaceId = "foreign-workspace";
    if (problem === "foreign-session") context.parent.sessionId = context.child.sessionId = "foreign-session";
    if (problem === "wrong-task") request.payload.taskId = "unrelated-task";
    if (problem === "wrong-owner") context.child.ownerLaneId = peer;
    run.inbox.push({ message: request, status: "handled", sentAtOffset: 5 });
    if (problem === "conflicting-parents") run.inbox.push({ message: scopedTeamMessage(member, peer), status: "handled", sentAtOffset: 6 });
    const original = structuredClone(run);

    const snapshot = projectAgentTopology(composeAgentAwarenessProjectionInput({
      workspaceId: "repo", sessionId: "session-a", now, runs: [{ projection: run }],
    }));
    const root = snapshot.nodes.find((node) => node.endpoint.laneId === "main")!;
    const child = snapshot.nodes.find((node) => node.endpoint.laneId === member)!;
    expect(snapshot.edges.filter((edge) => edge.target === child.key && edge.relation === "parent"))
      .toEqual([{ source: root.key, target: child.key, relation: "parent" }]);
    expect(run).toEqual(original);
  });

  it.each([
    event("lane.status", { status: "running" }, "teto"),
    event("step.completed", { step: 1, hasToolCalls: false }, "teto"),
    event("model.requested", { model: "model:teto", requestHash: "request-hash", contextWatermark: 0 }, "teto"),
  ])("recovers legacy execution evidence without a start marker: $type", async (execution) => {
    const ledger = await availableLanes();
    await ledger.append(execution);
    await ledger.append(event("lane.status", { status: "dormant", reason: "Legacy activation ended" }, "teto"));
    expect((await activationSnapshot(ledger)).nodes.map((node) => node.endpoint.laneId)).toEqual(["main", "teto"]);
  });

  it("preserves idle legacy host projections with steps while excluding unused slots", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo", sessionId: "session-a", now,
      runs: [{ projection: projection("legacy", {
        main: lane("main", "ready"),
        teto: { ...lane("teto", "dormant", "intent-navigator"), lastStep: 1 },
        worker: lane("worker", "ready", "worker"),
        unused: lane("unused", "cancelled", "worker"),
        waiting: lane("waiting", "waiting", "worker"),
      }) }],
    });
    expect(projectAgentTopology(input).nodes.map((node) => node.endpoint.laneId)).toEqual(["main", "teto"]);
  });

  it("combines Runs, lanes, Host, Worker, roster and lineage into one projection input", () => {
    const roster: CrossRunRoster = {
      current: { workspaceId: "repo", sessionId: "session-a", runId: "run-a", laneId: "main" },
      entries: [
        {
          endpoint: { workspaceId: "repo", sessionId: "session-c", runId: "run-c", laneId: "worker" },
          relationship: "child",
          status: "busy",
          reachable: true,
        },
        {
          endpoint: { workspaceId: "repo", sessionId: "session-b", runId: "run-b", laneId: "main" },
          relationship: "sibling",
          status: "busy",
          reachable: true,
        },
      ],
    };
    const options: AgentAwarenessCompositionOptions = {
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      runs: [
        {
          projection: projection("run-a", {
            main: lane("main", "running"),
            teto: { ...lane("teto", "waiting", "intent-navigator"), activated: true },
            worker: lane("worker", "running", "worker"),
          }),
          session: session("run-a"),
          generation: 3,
          activitySummary: "analyzing secret=never-expose /private/project",
        },
        {
          projection: projection("run-b", { main: lane("main", "waiting") }),
          scope: { sessionId: "session-b" },
          session: session("run-b", "idle"),
        },
      ],
      host: {
        status: "running",
        ownerId: "daemon-owner",
        queuedRuns: 1,
        runningRuns: 0,
        attachedClients: 1,
        runs: [{ runId: "run-b", state: "queued", pendingWakeCount: 1 }],
      },
      workers: [{
        descriptor: descriptor("run-a", 7),
        laneId: "worker-process",
        active: true,
      }],
      roster,
      lineage: [{
        source: { workspaceId: "repo", sessionId: "session-c", runId: "run-c", laneId: "worker" },
        target: { workspaceId: "repo", sessionId: "session-a", runId: "run-a", laneId: "main" },
        relation: "fork-of",
      }],
    };

    const input = composeAgentAwarenessProjectionInput(options);
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes.map((node) => [node.endpoint.runId, node.endpoint.laneId, node.role, node.state])).toEqual([
      ["daemon-host", "daemon", "daemon", "active"],
      ["run-a", "main", "main", "active"],
      ["run-a", "teto", "teto", "waiting"],
      ["run-a", "worker", "worker", "active"],
      ["run-a", "worker-process", "worker", "active"],
      ["run-b", "main", "main", "starting"],
      ["run-c", "worker", "worker", "active"],
    ]);
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "observer" }),
      expect.objectContaining({ relation: "peer" }),
      expect.objectContaining({ relation: "fork-of" }),
      expect.objectContaining({ relation: "delegates" }),
      expect.objectContaining({ relation: "routes-to" }),
      expect.objectContaining({ relation: "hosted-by" }),
    ]));
    expect(snapshot.availability).toBe("fresh");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "run-a" && node.endpoint.laneId === "main")?.activitySummary)
      .toBe("analyzing [redacted] [path]");
    expect(JSON.stringify(snapshot)).not.toContain("private/should-never");
    expect(JSON.stringify(snapshot)).not.toContain("lease");
    expect(input.records?.every((record) => record.authorized === true && record.visible === true)).toBe(true);
  });

  it("keeps the newest worker generation and marks stale or held sources safely", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      freshnessMs: 5 * 60_000,
      host: {
        status: "running",
        ownerId: "daemon-owner",
        queuedRuns: 0,
        runningRuns: 0,
        attachedClients: 0,
        runs: [{ runId: "held", state: "held", pendingWakeCount: 0, fencingToken: 2 }],
      },
      workers: [
        { descriptor: descriptor("stale", 1, "2026-09-01T11:00:00.000Z") },
        { descriptor: descriptor("same", 1), activitySummary: "old" },
        { descriptor: descriptor("same", 2), activitySummary: "new" },
      ],
    });
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "stale")?.state).toBe("offline");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "held")?.state).toBe("sleeping");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.generation).toBe(2);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.activitySummary).toBe("new");
  });

  it("requires an explicit non-path scope and ignores sensitive source metadata", () => {
    expect(() => composeAgentAwarenessProjectionInput({
      sessionId: "session-a",
      runs: [{ projection: projection("run-a", { main: lane("main", "running") }) }],
    })).toThrow(/workspaceId is required/u);
    expect(() => composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      runs: [{ projection: projection("run-a", { main: lane("main", "running") }), session: session("other") }],
    })).toThrow(/does not match/u);
  });

  it("is deterministic when source arrays arrive in a different order", () => {
    const base: AgentAwarenessCompositionOptions = {
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      runs: [
        { projection: projection("b", { main: lane("main", "waiting") }) },
        { projection: projection("a", { main: lane("main", "running") }) },
      ],
      workers: [{ descriptor: descriptor("a", 1) }],
      lineage: [{
        source: { workspaceId: "repo", sessionId: "session-a", runId: "a", laneId: "main" },
        target: { workspaceId: "repo", sessionId: "session-a", runId: "b", laneId: "main" },
        relation: "peer",
      }],
    };
    const reverse: AgentAwarenessCompositionOptions = {
      ...base,
      runs: [...base.runs!].reverse(),
      workers: [...base.workers!].reverse(),
      lineage: [...base.lineage!].reverse(),
    };
    expect(composeAgentAwarenessProjectionInput(base)).toEqual(composeAgentAwarenessProjectionInput(reverse));
  });

  it("marks an empty composition unavailable and an old observation stale", () => {
    expect(projectAgentTopology(composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
    })).availability).toBe("unavailable");

    const stale = composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      runs: [{
        projection: projection("old", { main: lane("main", "waiting") }),
        lastSeen: "2026-09-01T11:00:00.000Z",
      }],
    });
    expect(stale.availability).toBe("stale");
    expect(projectAgentTopology(stale).nodes[0]?.state).toBe("offline");
  });

  it("drops a roster marked unauthorized before it can create nodes or edges", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      roster: {
        authorized: false,
        roster: {
          current: { workspaceId: "repo", sessionId: "session-a", runId: "current", laneId: "main" },
          entries: [{
            endpoint: { workspaceId: "repo", sessionId: "session-b", runId: "hidden", laneId: "worker" },
            relationship: "child",
            status: "busy",
            reachable: true,
          }],
        },
      },
    });
    expect(input.records).toEqual([]);
    expect(input.edges).toEqual([]);
    expect(projectAgentTopology(input).availability).toBe("unavailable");
  });

  it("keeps multiple detached workers distinct and exposes their host edges", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      supervisor: {
        lifecycle: "ready",
        maxWorkers: 4,
        maxPendingRuns: 8,
        host: {
          status: "running",
          ownerId: "private-owner",
          queuedRuns: 0,
          runningRuns: 0,
          attachedClients: 0,
          runs: [],
        },
        workers: [
          {
            runId: "run-worker",
            workerId: "worker-a",
            generation: 1,
            state: "running",
            instanceTokenPresent: true,
          },
          {
            runId: "run-worker",
            workerId: "worker-b",
            generation: 2,
            state: "crashed",
            instanceTokenPresent: false,
          },
        ],
      },
    });
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes
      .filter((node) => node.role === "worker")
      .map((node) => [node.endpoint.laneId, node.state, node.generation])).toEqual([
      ["detached-worker:worker-a", "active", 1],
      ["detached-worker:worker-b", "offline", 2],
    ]);
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "hosted-by" }),
      expect.objectContaining({ relation: "delegates" }),
    ]));
  });

  it("reuses an explicit Run scope for the daemon when no global scope is set", () => {
    const input = composeAgentAwarenessProjectionInput({
      now,
      runs: [{
        projection: projection("scoped-run", { main: lane("main", "running") }),
        scope: { workspaceId: "repo", sessionId: "session-scoped" },
      }],
      host: {
        status: "running",
        ownerId: "private-owner",
        queuedRuns: 0,
        runningRuns: 0,
        attachedClients: 0,
        runs: [],
      },
    });
    expect(projectAgentTopology(input).nodes[0]?.endpoint).toMatchObject({
      workspaceId: "repo",
      sessionId: "session-scoped",
      runId: "daemon-host",
      laneId: "daemon",
    });
  });
});
