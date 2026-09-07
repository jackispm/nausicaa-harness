import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AMessage, TaskResult } from "../../src/domain/types.js";
import type { AppendEvent } from "../../src/domain/events.js";
import type { TeamDefinition } from "../../src/domain/team.js";
import { A2AInbox } from "../../src/a2a/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { TeamLifecycle } from "../../src/runtime/team-lifecycle.js";

const start = Date.parse("2026-09-07T00:00:00.000Z");
const lifecycles: TeamLifecycle[] = [];
afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.close()));
});

async function scenario(options: { modern?: boolean; explicitDeadline?: boolean; sendRequest?: boolean } = {}) {
  let now = start;
  const clock = { now: () => new Date(now) };
  const ledger = new MemoryLedger({ clock });
  const inbox = new A2AInbox({ sink: ledger, clock });
  const stopped: string[] = [];
  const wake = vi.fn();
  const definition: TeamDefinition = {
    teamId: "alpha", leadLaneId: "main", fingerprint: "alpha-definition",
    peerMessaging: "team-members", joinPolicy: "all-terminal", deadline: new Date(start + 1_000).toISOString(),
    members: [{
      memberId: "one", laneId: "team:alpha:one", dependsOn: [], required: true,
      task: {
        type: "task.request", taskId: "alpha:one",
        goal: { version: 1, statement: "Inspect one area", successCriteria: [], hardConstraints: [] },
        inputRefs: [], budget: {
          maxModelTokens: 100, maxWallClockMs: 1_000,
          ...(options.explicitDeadline === false ? {} : { deadline: new Date(start + 1_000).toISOString() }),
        },
      },
    }],
  };
  const member = definition.members[0]!;
  const request: A2AMessage = {
    messageId: "request-one", runId: "run-team", conversationId: "run-team", threadId: "team-alpha",
    from: "main", to: member.laneId, createdAt: clock.now().toISOString(), correlationId: "team-alpha",
    idempotencyKey: "request-one", visibility: "run", priority: 1, delivery: "next-step", payload: member.task,
  };
  const lifecycle = new TeamLifecycle({
    runId: "run-team", leadLaneId: "main", ledger, inbox, clock,
    readEvents: () => ledger.read({ runId: "run-team" }),
    stopMember: async (laneId) => { stopped.push(laneId); },
    onWake: wake,
  });
  lifecycles.push(lifecycle);
  const append = (event: Pick<AppendEvent, "type" | "payload" | "laneId" | "idempotencyKey">) => ledger.append({
    ...event, runId: "run-team", correlationId: "team-alpha", visibility: "run", occurredAt: clock.now().toISOString(),
  });
  if (options.modern) await lifecycle.create(definition);
  if (options.sendRequest !== false) await inbox.send(request);
  const result: TaskResult = {
    type: "task.result", taskId: member.task.taskId, status: "completed", summary: "Evidence checked",
    evidenceRefs: [], artifactRefs: [], openQuestions: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    ledger, inbox, lifecycle, member, definition, request, result, stopped, wake, append,
    advance: (milliseconds: number) => { now += milliseconds; },
    board: async () => (await lifecycle.boards())[0]!,
    claim: async () => (await inbox.claim(member.laneId, member.laneId, { runId: "run-team", claimId: "claim-one" }))[0]!.claim!,
  };
}

describe("Team lifecycle compatibility and deadlines", () => {
  it("durably cancels a legacy Team, stops its executor, and sends one recoverable notice", async () => {
    const s = await scenario();
    await s.lifecycle.cancel("alpha", "Stopped by user");
    expect(await s.board()).toMatchObject({ cancellationRequested: true, joinState: "cancelled", status: "cancelled" });
    expect((await s.board()).members[0]?.outcome).toBe("cancelled");
    expect(s.stopped).toEqual(["team:alpha:one"]);
    expect(s.wake).toHaveBeenCalledTimes(1);
    await s.lifecycle.cancel("alpha", "Repeated cancellation");
    await s.lifecycle.restore();
    expect(s.stopped).toHaveLength(1);
    const events = await s.ledger.read();
    expect(events.filter((event) => event.type === "team.cancelled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "team.member.settled")).toHaveLength(1);
    expect(s.wake).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("settles expired legacy work using its original admission (explicit deadline: %s)", async (explicitDeadline) => {
    const s = await scenario({ explicitDeadline });
    s.advance(10_000);
    await s.lifecycle.restore();
    expect((await s.board()).members[0]).toMatchObject({ terminal: true, outcome: "abandoned" });
    expect((await s.board()).joinSatisfied).toBe(true);
    expect(s.stopped).toEqual(["team:alpha:one"]);
    expect((await s.ledger.read()).some((event) => event.type === "team.joined")).toBe(true);
  });

  it("does not reset a legacy budget when resuming before its deadline", async () => {
    const s = await scenario({ explicitDeadline: false });
    s.advance(500);
    await s.lifecycle.restore();
    expect((await s.board()).members[0]?.terminal).toBe(false);
    s.advance(501);
    await s.lifecycle.reconcile();
    expect((await s.board()).members[0]?.outcome).toBe("abandoned");
  });

  it("settles a legacy registration whose original task admission cannot be recovered", async () => {
    const s = await scenario({ sendRequest: false });
    await s.append({ type: "lane.registered", payload: { kind: "team" }, laneId: s.member.laneId, idempotencyKey: "registered" });
    await s.lifecycle.restore();
    expect((await s.board()).members[0]).toMatchObject({
      terminal: true, outcome: "abandoned", reason: "Task deadline cannot be reconstructed from admission",
    });
  });

  it("ignores forged cancellation facts and uses the authenticated lead reason", async () => {
    const s = await scenario();
    await s.append({ type: "team.cancel.requested", payload: { teamId: "alpha", reason: "Forged lane", requestedBy: "main" }, laneId: "peer", idempotencyKey: "forged-lane" });
    await s.append({ type: "team.cancel.requested", payload: { teamId: "alpha", reason: "Forged requester", requestedBy: "peer" }, laneId: "main", idempotencyKey: "forged-requester" });
    await s.lifecycle.reconcile();
    expect(s.stopped).toHaveLength(0);
    expect((await s.board()).cancellationRequested).toBe(false);
    await s.lifecycle.cancel("alpha", "Real cancellation");
    const cancelled = (await s.ledger.read()).find((event) => event.type === "team.cancelled");
    expect(cancelled?.payload).toMatchObject({ reason: "Real cancellation" });
    expect((await s.board()).joinState).toBe("cancelled");
  });

  it("fences a provider result that arrives after its deadline before the timer can run", async () => {
    const s = await scenario({ modern: true });
    const claim = await s.claim();
    s.advance(1_001);
    await expect(s.lifecycle.settle("alpha", s.member, s.request, claim, s.result)).rejects.toThrow(/after its deadline/);
    expect((await s.board()).members[0]).toMatchObject({ terminal: true, outcome: "abandoned" });
    expect((await s.board()).members[0]?.result).toBeUndefined();
    await s.lifecycle.reconcile();
    expect((await s.board()).joinSatisfied).toBe(true);
    expect((await s.ledger.read()).filter((event) => event.type === "team.member.settled")).toHaveLength(1);
  });

  it("gives an explicit reducer its own deadline after the Team collection deadline", async () => {
    const s = await scenario({ modern: true });
    await s.lifecycle.settle("alpha", s.member, s.request, await s.claim(), s.result);
    await s.lifecycle.reconcile();
    s.advance(900);
    const reducer = {
      ...s.member, memberId: "reducer", laneId: "team-reducer:alpha",
      task: {
        ...s.member.task, taskId: "team:alpha:reduction",
        budget: { ...s.member.task.budget, deadline: new Date(start + 1_900).toISOString() },
      },
    };
    await s.lifecycle.requestReduction("alpha", reducer);
    const request: A2AMessage = {
      ...s.request, messageId: "reduction-request", idempotencyKey: "reduction-request",
      createdAt: new Date(start + 900).toISOString(), to: reducer.laneId, payload: reducer.task,
    };
    await s.inbox.send(request);
    const claim = (await s.inbox.claim(reducer.laneId, reducer.laneId, { runId: "run-team", claimId: "reducer-claim" }))[0]!.claim!;
    s.advance(200);
    await s.lifecycle.settle("alpha", reducer, request, claim, { ...s.result, taskId: reducer.task.taskId }, true);
    expect(await s.board()).toMatchObject({ reductionState: "completed", reduction: { outcome: "succeeded" } });
  });
});
