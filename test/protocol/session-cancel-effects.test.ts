import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTool, AnyEvent, ModelPort, ModelResponse, ToolResult } from "../../src/domain/index.js";
import { annotateTool } from "../../src/mowe/catalog.js";
import { ScriptedModel } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Session forced cancellation effects", () => {
  it.each(["read", "compute", "write", "external", undefined] as const)(
    "uses captured explicit %s metadata to distinguish cancellation from unknown effects",
    async (effect) => {
      const root = await temporaryRoot();
      const started = deferred<void>();
      const oldResult = deferred<ToolResult>();
      const base: AgentTool = {
        definition: { name: "held_tool", description: "Held tool", parameters: { type: "object" } },
        async execute() { started.resolve(); return oldResult.promise; },
      };
      const tool = effect === undefined ? base : annotateTool(base, { effect });
      const events: AnyEvent[] = [];
      const session = await SessionController.open({
        workspace: root, dataDir: join(root, "state"), model: "scripted", cancelGraceMs: 5,
        policy: { tetoEnabled: false, workerEnabled: false },
      }, {
        mainModel: new ScriptedModel([
          { ...response("Start"), stopReason: "toolUse", toolCalls: [{ id: "held", name: "held_tool", arguments: {} }] },
          response("Follow-up"),
        ]),
        tools: [tool], createRunId: () => "cancel-effects",
      });
      session.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      try {
        await session.submit({ inputId: "initial", text: "Original request" });
        await started.promise;
        await session.cancel("Interrupted", { cancelTeams: false });
        expect(session.snapshot().status).toBe("idle");
        if (effect === "read" || effect === "compute") {
          expect(session.snapshot().blocker).toBeUndefined();
          expect(events.some((event) => event.type === "tool.unknown")).toBe(false);
          expect(events.filter((event) => event.type === "tool.failed")).toMatchObject([
            { payload: { toolCallId: "held", error: "Tool execution was cancelled" } },
          ]);
          await session.submit({ inputId: "next", text: "Continue" });
          await session.waitForIdle();
          expect(session.snapshot().runId).toBe("cancel-effects");
        } else {
          expect(session.snapshot().blocker).toMatch(/^operation-unknown:/u);
          expect(events.filter((event) => event.type === "tool.unknown")).toHaveLength(1);
          expect(events.some((event) => event.type === "tool.failed")).toBe(false);
        }
        oldResult.resolve({ content: "Late old result", isError: false });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events.some((event) => event.type === "tool.succeeded")).toBe(false);
      } finally {
        oldResult.resolve({ content: "Cleanup", isError: false });
        await session.close();
      }
    },
  );

  it("cancels real task_wait after its settlement exceeds grace without blocking the next input", async () => {
    const root = await temporaryRoot();
    const workerStarted = deferred<void>();
    const workerResult = deferred<ModelResponse>();
    const waitStarted = deferred<void>();
    const waitCleanup = deferred<void>();
    const waitSettled = deferred<void>();
    const realWait = TeamRuntime.prototype.wait;
    const waitSpy = vi.spyOn(TeamRuntime.prototype, "wait").mockImplementation(async function (this: TeamRuntime, request, context) {
      waitStarted.resolve();
      try {
        return await realWait.call(this, request, context);
      } finally {
        // The real event-driven wait receives cancellation, but its adapter
        // cleanup outlives the Session grace just as a busy host can.
        await waitCleanup.promise;
        waitSettled.resolve();
      }
    });
    const events: AnyEvent[] = [];
    const worker: ModelPort = {
      async complete() { workerStarted.resolve(); return workerResult.promise; },
    };
    const main = new ScriptedModel([
      {
        ...response("Create Team"), stopReason: "toolUse",
        toolCalls: [{ id: "create", name: "team_create", arguments: {
          teamId: "work", members: [{ memberId: "physics", statement: "Work on physics" }],
        } }],
      },
      async () => {
        await workerStarted.promise;
        return {
          ...response("Wait for physics"), stopReason: "toolUse",
          toolCalls: [{ id: "wait", name: "task_wait", arguments: { teamId: "work", taskId: "work:physics" } }],
        };
      },
      (request) => {
        expect(request.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Create the requested Team" }),
          expect.objectContaining({ role: "tool", toolCallId: "wait", isError: true }),
          expect.objectContaining({ role: "user", content: "Continue in this Run" }),
        ]));
        return response("Follow-up accepted");
      },
    ]);
    const session = await SessionController.open({
      workspace: root, dataDir: join(root, "state"), model: "scripted", workerModel: "member",
      policy: { tetoEnabled: false, workerEnabled: false }, cancelGraceMs: 5,
    }, {
      mainModel: main, workerModel: worker, tools: [], workerTools: [], createRunId: () => "cancel-real-wait",
    });
    session.subscribe((event) => {
      if (event.kind !== "event") return;
      events.push(event.event);
    });
    try {
      await session.submit({ inputId: "initial", text: "Create the requested Team" });
      await waitStarted.promise;
      await session.cancel("Interrupt the wait", { cancelTeams: false });
      expect(session.snapshot()).toMatchObject({ runId: "cancel-real-wait", status: "idle" });
      expect(session.snapshot().blocker).toBeUndefined();
      expect(events.some((event) => event.type === "tool.unknown" || event.type === "team.cancelled")).toBe(false);
      expect(events.filter((event) => event.type === "tool.failed" && event.payload.toolCallId === "wait"))
        .toMatchObject([{ payload: { error: "Tool execution was cancelled" } }]);
      await session.submit({ inputId: "next", text: "Continue in this Run" });
      await session.waitForIdle();
      expect(main.callCount).toBe(3);
      waitCleanup.resolve();
      await waitSettled.promise;
      expect(events.filter((event) => event.type === "tool.failed" && event.payload.toolCallId === "wait")).toHaveLength(1);
    } finally {
      waitCleanup.resolve();
      await session.close();
      waitSpy.mockRestore();
      workerResult.resolve(response("Late member result"));
    }
  });
});

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-cancel-effects-"));
  roots.push(root);
  return root;
}
