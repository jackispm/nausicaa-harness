import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AnyEvent, ModelPort, ModelRequest, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun, SessionController } from "../../src/runtime/index.js";

describe("Teto host activation recovery", () => {
  it.each(["executeRun", "SessionController"] as const)(
    "%s preserves Main's stop across reopening and permits an explicit restart",
    async (host) => {
      const workspace = await mkdtemp(join(tmpdir(), "nausicaa-teto-recovery-"));
      const runId = `teto-recovery-${host}`;
      const options = {
        workspace, dataDir: join(workspace, "state"), model: "scripted-main", tetoModel: "scripted-teto",
        policy: { maxMainStepsPerActivation: 3, maxModelTokens: 100_000, tetoMaxOutputTokens: 64, workerEnabled: false },
      };
      const run = async (mainModel: ScriptedModel, tetoModel: ModelPort, resume: boolean) => {
        const deps = { mainModel, tetoModel, tools: [], createRunId: () => runId };
        if (host === "executeRun") {
          const result = await executeRun({
            ...options,
            ...(resume ? { resumeRunId: runId } : { message: "Check Teto, then pause its observation" }),
          }, deps);
          expect(result.completed).toBe(resume);
          expect(result.blocker).toBe(resume ? undefined : "model-output-limit");
        } else {
          const session = await SessionController.open({ ...options, ...(resume ? { runId } : {}) }, deps);
          try {
            if (resume) await session.resumeCurrent();
            else await session.submit({ inputId: "first", text: "Check Teto, then pause its observation" });
            await session.waitForIdle();
            expect(session.snapshot().blocker).toBe(resume ? undefined : "model-output-limit");
          } finally {
            await session.close();
          }
        }
        expect(mainModel.callCount).toBe(3);
      };

      try {
        const initialObserver = observer();
        await run(new ScriptedModel([
          async () => {
            await initialObserver.started;
            return toolCall("initial-status", "teto_status");
          },
          (request) => {
            expectToolResult(request, "initial-status", { active: true, available: true });
            return toolCall("stop-observer", "teto_stop");
          },
          (request) => {
            expectToolResult(request, "stop-observer", { active: false, changed: true });
            return { ...response("Pause at a resumable boundary"), stopReason: "length" };
          },
        ]), initialObserver.model, false);
        expect(initialObserver.requests.length).toBeGreaterThan(0);
        const before = await readEvents(options.dataDir, runId);
        expect(controls(before)).toEqual(["start", "stop"]);
        expect(before.find((event) => event.type === "run.created")?.payload)
          .toMatchObject({ policy: { tetoEnabled: true, tetoActivation: "automatic" } });

        const resumedObserver = observer();
        await run(new ScriptedModel([
          () => {
            expect(resumedObserver.requests).toHaveLength(0);
            return toolCall("resumed-status", "teto_status");
          },
          (request) => {
            expectToolResult(request, "resumed-status", { active: false, available: true });
            expect(resumedObserver.requests).toHaveLength(0);
            return toolCall("restart-observer", "teto_start");
          },
          async (request) => {
            expectToolResult(request, "restart-observer", { active: true, changed: true });
            await resumedObserver.started;
            return response("Teto restarted explicitly");
          },
        ]), resumedObserver.model, true);
        expect(resumedObserver.requests.length).toBeGreaterThan(0);
        expect(controls(await readEvents(options.dataDir, runId)))
          .toEqual(["start", "stop", "start"]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});

function observer(): { model: ModelPort; requests: ModelRequest[]; started: Promise<void> } {
  const requests: ModelRequest[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  return {
    requests,
    started,
    model: {
      async complete(request) {
        requests.push(request);
        markStarted();
        return response("Observed");
      },
    },
  };
}

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } };
}

function toolCall(id: string, name: string): ModelResponse {
  return { ...response(name), stopReason: "toolUse", toolCalls: [{ id, name, arguments: {} }] };
}

function expectToolResult(request: ModelRequest, toolCallId: string, expected: Record<string, boolean>): void {
  const result = request.messages.find((message) => message.role === "tool" && message.toolCallId === toolCallId);
  expect(result).toMatchObject({ role: "tool", isError: false });
  expect(JSON.parse(result!.content)).toMatchObject(expected);
}

function controls(events: readonly AnyEvent[]): string[] {
  return events.flatMap((event) => (
    event.type === "lane.status" && event.laneId === "teto" && event.payload.control !== undefined
      ? [event.payload.control.action] : []
  ));
}

async function readEvents(dataDir: string, runId: string): Promise<AnyEvent[]> {
  const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
  try {
    return await ledger.read({ runId });
  } finally {
    await ledger.close();
  }
}
