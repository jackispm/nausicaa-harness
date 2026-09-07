import { describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const RUN_ID = "team-cancellation-admission";
const MEMBER_INPUT = "Input whose persistence overlaps user cancellation";
type AdmissionBoundary = "input" | "team.created" | "task.request";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

class GatedLedger extends MemoryLedger {
  readonly entered = deferred();
  readonly release = deferred();
  private blocked = false;

  constructor(private readonly boundary: AdmissionBoundary) { super(); }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    const matches = this.boundary === "team.created" && input.type === "team.created"
      || this.boundary === "task.request" && input.type === "message.sent"
        && "message" in input.payload && input.payload.message.payload.type === "task.request";
    if (!this.blocked && matches) {
      this.blocked = true;
      this.entered.resolve();
      await this.release.promise;
    }
    return super.append(input);
  }
}

describe("Team admission cancellation", () => {
  it.each<AdmissionBoundary>(["input", "team.created", "task.request"])(
    "fences members when cancellation overlaps the %s write",
    async (boundary) => {
      const ledger = new GatedLedger(boundary);
      const store = new MemoryContentAddressedStore();
      const put = store.put.bind(store);
      if (boundary === "input") {
        vi.spyOn(store, "put").mockImplementation(async (data, mediaType) => {
          if (data === MEMBER_INPUT) {
            ledger.entered.resolve();
            await ledger.release.promise;
          }
          return put(data, mediaType);
        });
      }
      const inbox = new A2AInbox({ sink: ledger });
      const complete = vi.fn(async (): Promise<ModelResponse> => ({
        content: "A cancelled member must not execute", stopReason: "stop", toolCalls: [],
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
      }));
      const runtime = new TeamRuntime({
        eventSink: ledger, inbox, store, model: { complete }, modelName: "scripted-team",
        runId: RUN_ID, workspace: process.cwd(), branchTools: [],
        runTokenBudget: new RunTokenBudget(100_000),
        policy: {
          maxMainStepsPerActivation: 3, maxModelTokens: 100_000,
          tetoEnabled: false, tetoMaxOutputTokens: 64, workerEnabled: false,
        },
        readEvents: () => ledger.read({ runId: RUN_ID }),
        readWatermark: () => ledger.watermark(),
        readAwareness: () => ({
          version: 1, generatedAt: new Date().toISOString(), availability: "fresh",
          nodes: [], edges: [], roots: [], truncated: false,
        }),
      });
      const controller = new AbortController();
      const context: ToolExecutionContext = {
        runId: RUN_ID, laneId: "main", workspace: process.cwd(), operationId: "create-team",
        signal: controller.signal,
      };
      try {
        // Observe rejection immediately so cancellation can reject admission
        // while cancelAll waits for the same admission boundary to settle.
        const creating = runtime.create({
          teamId: "review",
          members: [{
            memberId: "one", statement: "Inspect evidence", input: MEMBER_INPUT,
            maxModelTokens: 12_000, maxWallClockMs: 10_000,
          }],
        }, context).then(() => undefined, () => undefined);
        await ledger.entered.promise;
        controller.abort(new Error("Cancelled by user"));
        const cancelling = runtime.cancelAll("Cancelled by user");
        ledger.release.resolve();
        await Promise.all([creating, cancelling]);
        await runtime.drain();

        expect(complete).not.toHaveBeenCalled();
        const events = await ledger.read({ runId: RUN_ID });
        expect(events.some((event) => event.type === "model.requested")).toBe(false);
        const boards = (await runtime.status({
          runId: RUN_ID, laneId: "main", workspace: process.cwd(), operationId: "status-team",
        })).teams;
        expect(boards.every((board) => board.cancellationRequested
          && board.members.every((member) => member.terminal))).toBe(true);
        if (boundary !== "input") {
          expect(boards).toHaveLength(1);
          expect(boards[0]?.joinState).toBe("cancelled");
        }
      } finally {
        ledger.release.resolve();
        await runtime.stop();
      }
    },
  );
});
