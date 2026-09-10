import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTool, AnyEvent, ModelPort, ModelResponse } from "../../src/domain/index.js";
import type { Ledger } from "../../src/ledger/ledger.js";
import { ScriptedModel } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/session-controller.js";

const roots: string[] = [];
const sessions: SessionController[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Session snapshot projections", () => {
  it("reuses ledger projections across animation frames and isolates mutable output", async () => {
    const session = await openSession([response("Finished")]);
    await session.submit({ inputId: "initial", text: "Answer" });
    await session.waitForIdle();
    const sink = attachedSink(session);
    const readCache = vi.spyOn(sink, "cachedEvents", "get");
    const expected = session.snapshot();
    readCache.mockClear();

    for (let frame = 0; frame < 120; frame += 1) {
      const snapshot = session.snapshot();
      expect(snapshot).toEqual(expected);
      snapshot.usage.input = 999_999;
      snapshot.workspaceBashAvailability.available = !expected.workspaceBashAvailability.available;
    }
    expect(readCache).not.toHaveBeenCalled();

    // These host settings do not append Ledger events. They must remain live
    // even when the expensive ledger-derived fields can be reused.
    const revision = sink.cacheRevision;
    await session.selectPermissionProfile("full-access");
    await session.selectCollaborationMode("plan");
    expect(sink.cacheRevision).toBe(revision);
    expect(session.snapshot()).toMatchObject({
      permissionProfile: "full-access", collaborationMode: "plan",
      allowWrite: true, allowShell: true, allowNetwork: true,
      usage: expected.usage,
    });
    expect(readCache).not.toHaveBeenCalled();
  });

  it("invalidates on append before event observers read the next snapshot", async () => {
    const session = await openSession([response("Finished")]);
    await session.submit({ inputId: "initial", text: "Answer" });
    await session.waitForIdle();
    const before = session.snapshot();
    const seen: number[] = [];
    session.subscribe((event) => {
      if (event.kind === "event" && event.event.idempotencyKey === "snapshot-extra-usage") {
        seen.push(session.snapshot().usage.input);
      }
    });
    await attachedSink(session).append({
      runId: before.runId!, laneId: "main", type: "budget.charged",
      payload: { laneId: "main", usage: { input: 17, output: 3, cacheRead: 0, cacheWrite: 0 } },
      correlationId: "snapshot-usage", idempotencyKey: "snapshot-extra-usage", visibility: "run",
    });
    expect(seen).toEqual([before.usage.input + 17]);
    expect(session.snapshot().usage.output).toBe(before.usage.output + 3);
  });

  it("invalidates replacement and rollback even when the watermark does not advance", async () => {
    const session = await openSession([response("Finished")]);
    await session.submit({ inputId: "initial", text: "Answer" });
    await session.waitForIdle();
    const sink = attachedSink(session);
    const original = sink.cachedEvents;
    const before = session.snapshot();
    const replacement = structuredClone(original);
    const charged = replacement.find((event) => event.type === "budget.charged");
    if (charged?.type !== "budget.charged") throw new Error("Missing durable usage");
    charged.payload.usage.input += 23;
    const watermark = sink.cachedLastOffset;
    try {
      sink.replaceCache(replacement);
      expect(sink.cachedLastOffset).toBe(watermark);
      expect(session.snapshot().usage.input).toBe(before.usage.input + 23);
      sink.replaceCache(original.slice(0, 1));
      expect(sink.cachedLastOffset).toBeLessThan(watermark);
      expect(session.snapshot()).toMatchObject({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        pendingInputs: 0, mainContextTokens: null,
      });
    } finally {
      sink.replaceCache(original);
    }
    expect(session.snapshot().usage).toEqual(before.usage);
  });

  it("keeps active state, queued inputs, context and model selection current", async () => {
    let nextStarted!: () => void;
    const started = new Promise<void>((resolve) => { nextStarted = resolve; });
    let finish!: (value: ModelResponse) => void;
    const pending = new Promise<ModelResponse>((resolve) => { finish = resolve; });
    const noop: AgentTool = {
      definition: { name: "noop", description: "No effect", parameters: { type: "object" } },
      async execute() { return { content: "OK", isError: false }; },
    };
    const session = await openSession([
      { ...response("Using a tool"), stopReason: "toolUse", toolCalls: [{ id: "noop-call", name: "noop", arguments: {} }] },
      () => { nextStarted(); return pending; },
      response("Handled follow-up input"),
    ], [noop]);
    await session.submit({ inputId: "initial", text: "Use a tool" });
    await started;
    const active = session.snapshot();
    expect(active.status).toBe("running");
    expect(active.turnId).toBeDefined();
    expect(active.lastCommittedStep).toBe(2);
    expect(active.mainContextTokens).toBeGreaterThan(0);
    await session.submit({ inputId: "later", text: "Later", delivery: "follow-up" });
    expect(session.snapshot().pendingInputs).toBe(1);
    await session.selectModel("other-model");
    expect(session.snapshot()).toMatchObject({ status: "running", model: "other-model", mainContextTokens: null });
    await session.cancel("test cancellation");
    finish(response("Discard this cancelled result"));
    await session.waitForIdle();
    expect(session.snapshot().status).toBe("idle");
    expect(session.snapshot().turnId).toBeUndefined();
    expect(session.snapshot().lastCommittedStep).toBe(0);
  });

  it("drops the previous Run projection on detach and attachment replacement", async () => {
    const session = await openSession([
      response("First", 3), response("Second", 11),
    ]);
    await session.submit({ inputId: "one", text: "First Run" });
    await session.waitForIdle();
    const first = session.snapshot();
    await session.newRun();
    expect(session.snapshot()).toMatchObject({ status: "detached", usage: { input: 0, output: 0 } });
    await session.submit({ inputId: "two", text: "Second Run" });
    await session.waitForIdle();
    const second = session.snapshot();
    expect(second.runId).not.toBe(first.runId);
    expect(second.usage.output).toBe(11);
    await session.attachRun(first.runId!);
    expect(session.snapshot()).toMatchObject({ runId: first.runId, usage: first.usage });
  });

  it("caches isolated Team activity and refreshes it after replacing the event cache", async () => {
    const session = await openSession([
      {
        ...response("Create Team"), stopReason: "toolUse",
        toolCalls: [{ id: "create", name: "team_create", arguments: {
          teamId: "active-team", members: [{ memberId: "worker", statement: "Inspect the workspace" }],
        } }],
      },
      response("The member continues asynchronously"),
    ], [], new ScriptedModel([() => new Promise(() => undefined)]));
    await session.submit({ inputId: "team", text: "Create a Team" });
    await session.waitForIdle();
    const sink = attachedSink(session);
    const original = sink.cachedEvents;
    const expected = session.teamActivity();
    expect(expected.members).toHaveLength(1);
    const readCache = vi.spyOn(sink, "cachedEvents", "get");
    for (let frame = 0; frame < 120; frame += 1) {
      const snapshot = session.teamActivity();
      expect(snapshot).toEqual(expected);
      snapshot.members[0]!.tools.push("caller mutation");
      snapshot.members[0]!.memberId = "changed by caller";
    }
    expect(readCache).not.toHaveBeenCalled();
    try {
      sink.replaceCache(original.filter((event) => event.type !== "team.created"));
      expect(session.teamActivity()).toEqual({ members: [] });
    } finally {
      sink.replaceCache(original);
    }
    expect(session.teamActivity()).toEqual(expected);
    await session.newRun();
    expect(session.teamActivity()).toEqual({ members: [] });
  });
});

function response(content: string, output = 5): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 13, output, cacheRead: 0, cacheWrite: 0 } };
}

async function openSession(
  steps: ConstructorParameters<typeof ScriptedModel>[0],
  tools: readonly AgentTool[] = [],
  workerModel?: ModelPort,
): Promise<SessionController> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-snapshot-"));
  roots.push(root);
  let sequence = 0;
  const session = await SessionController.open({
    workspace: root, dataDir: join(root, "state"), model: "scripted",
    policy: { tetoEnabled: false, workerEnabled: false },
  }, {
    mainModel: new ScriptedModel(steps), tools, createRunId: () => `snapshot-run-${++sequence}`,
    ...(workerModel === undefined ? {} : { workerModel }),
  });
  sessions.push(session);
  return session;
}

// Exercise replacement at the internal cache boundary without mutating a
// durable Ledger or widening the production API solely for a regression test.
function attachedSink(session: SessionController): Ledger & {
  readonly cachedEvents: AnyEvent[];
  readonly cachedLastOffset: number;
  readonly cacheRevision: number;
  replaceCache(events: readonly AnyEvent[]): void;
} {
  return (session as unknown as { attached: { sink: ReturnType<typeof attachedSink> } }).attached.sink;
}
