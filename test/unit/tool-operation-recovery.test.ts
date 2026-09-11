import { describe, expect, it } from "vitest";

import type { AnyEvent, EventType } from "../../src/domain/events.js";
import {
  pendingStartedToolRequests,
  pendingToolOperations,
} from "../../src/runtime/tool-operation-recovery.js";

function fact(
  type: EventType,
  operationId: string,
  options: { runId?: string; turnId?: string } = {},
): AnyEvent {
  const runId = options.runId ?? "run-1";
  const turnId = options.turnId ?? "turn-1";
  const common = {
    operationId,
    toolCallId: `${operationId}-call`,
    name: "write_file",
  };
  const payload = type === "tool.requested"
    ? { ...common, argumentsRef: { id: `${operationId}-arguments` } }
    : type === "tool.admitted" || type === "tool.started"
      ? { ...common, argumentsHash: `sha256:${"a".repeat(64)}` }
      : type === "tool.unknown"
        ? { ...common, reason: "outcome unavailable" }
        : { ...common, resultRef: { id: `${operationId}-result` } };
  return { runId, turnId, type, payload } as unknown as AnyEvent;
}

describe("pendingStartedToolRequests", () => {
  it("classifies only started operations without a durable outcome as unknown", () => {
    const events = [
      fact("tool.requested", "requested-only"),
      fact("tool.requested", "admitted-only"),
      fact("tool.admitted", "admitted-only"),
      fact("tool.requested", "pending"),
      fact("tool.admitted", "pending"),
      fact("tool.started", "pending"),
      fact("tool.failed", "pending", { runId: "other-run" }),
      fact("tool.requested", "succeeded"),
      fact("tool.admitted", "succeeded"),
      fact("tool.started", "succeeded"),
      fact("tool.succeeded", "succeeded"),
      fact("tool.requested", "already-unknown"),
      fact("tool.admitted", "already-unknown"),
      fact("tool.started", "already-unknown"),
      fact("tool.unknown", "already-unknown"),
      fact("tool.requested", "other-turn", { turnId: "turn-2" }),
      fact("tool.admitted", "other-turn", { turnId: "turn-2" }),
      fact("tool.started", "other-turn", { turnId: "turn-2" }),
    ];

    expect(pendingStartedToolRequests(events, "run-1", "turn-1")
      .map((event) => event.payload.operationId))
      .toEqual(["pending"]);
  });

  it("keeps admitted-only calls retryable and preserves legacy request-only caution", () => {
    const modern = [
      fact("tool.requested", "admitted-only"),
      fact("tool.admitted", "admitted-only"),
      fact("tool.requested", "started"),
      fact("tool.admitted", "started"),
      fact("tool.started", "started"),
    ];
    expect(pendingToolOperations(modern).map((state) => [
      state.request.payload.operationId,
      state.phase,
    ])).toEqual([["started", "started"]]);

    const legacy = [fact("tool.requested", "request-only")];
    expect(pendingToolOperations(legacy).map((state) => [
      state.request.payload.operationId,
      state.phase,
    ])).toEqual([["request-only", "requested"]]);
  });

  it("does not hide a legacy request in a mixed lifecycle Run", () => {
    const mixed = [
      fact("tool.requested", "legacy"),
      fact("tool.requested", "modern"),
      fact("tool.admitted", "modern"),
      fact("tool.started", "modern"),
      fact("tool.succeeded", "modern"),
    ];
    expect(pendingToolOperations(mixed).map((state) => [
      state.request.payload.operationId,
      state.phase,
    ])).toEqual([["legacy", "requested"]]);
  });
});
