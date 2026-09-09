import { describe, expect, it } from "vitest";

import type { AppendEvent, EventType } from "../../src/domain/events.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  formatTracePreview,
  formatTraceStatus,
  projectRunMetrics,
} from "../../src/observability/index.js";

describe("local trace formatting", () => {
  it("describes a detached session without implying an upload path", () => {
    expect(formatTraceStatus(undefined)).toContain("Run: none attached");
    expect(formatTracePreview(undefined)).toContain("No Run is attached");
    expect(formatTraceStatus(undefined)).toContain("no upload or external network");
  });

  it("bounds recent events and strips terminal control characters", async () => {
    const ledger = new MemoryLedger();
    for (let index = 1; index <= 6; index += 1) {
      await append(ledger, "lane.status", {
        status: "running",
        reason: `event-${index}\u001b[31m`,
      }, `2026-09-09T00:00:0${index}.000Z`);
    }
    const events = await ledger.read({ runId: "trace-run" });
    const snapshot = {
      runId: "trace-run",
      ledgerPath: "/state/runs/trace-run/ledger.jsonl",
      events,
      metrics: projectRunMetrics(events, "trace-run"),
    };

    const status = formatTraceStatus(snapshot);
    expect(status).toContain("Events: 6; watermark 6");
    expect(status).toContain("Run: trace-run");

    const preview = formatTracePreview(snapshot, { maxEvents: 2, maxPayloadChars: 48 });
    expect(preview).toContain("showing 2 of 6");
    expect(preview).toContain("#5 ");
    expect(preview).toContain("#6 ");
    expect(preview).not.toContain("#4 ");
    expect(preview).not.toContain("\u001b");
    expect(preview).toContain("4 earlier event(s) omitted");
  });
});

async function append<K extends EventType>(
  ledger: MemoryLedger,
  type: K,
  payload: AppendEvent<K>["payload"],
  occurredAt: string,
): Promise<void> {
  await ledger.append({
    runId: "trace-run",
    laneId: "main",
    type,
    payload,
    correlationId: "trace-run",
    idempotencyKey: `${type}:${occurredAt}`,
    occurredAt,
  });
}
