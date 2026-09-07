import type { AnyEvent } from "../../src/domain/index.js";

export function peerEvidenceChecks(
  events: readonly AnyEvent[],
  runId: string,
  from: string,
  to: string,
  expected: Readonly<Record<string, number>>,
): { sent: boolean; consumed: boolean } {
  const scoped = events.filter((event) => event.runId === runId);
  const reads = scoped.filter((event) => event.type === "tool.succeeded"
    && event.laneId === from && event.payload.name === "read_file" && scoped.some((request) => (
      request.type === "tool.requested" && request.laneId === from && request.payload.name === "read_file"
      && request.payload.operationId === event.payload.operationId && request.globalOffset < event.globalOffset
    )));
  const sent = scoped.filter((event) => {
    if (event.type !== "message.sent" || event.laneId !== from) return false;
    const message = event.payload.message;
    return message.runId === runId && message.from === from && message.to === to
      && message.sourceEndpoint === undefined && message.targetEndpoint === undefined
      && message.payload.type === "message.inform" && matchesEvidence(message.payload.text, expected)
      && reads.some((read) => read.globalOffset < event.globalOffset);
  }).filter((event) => event.type === "message.sent");
  return {
    sent: sent.length > 0,
    consumed: sent.some((message) => scoped.some((event) => event.type === "step.completed"
      && event.laneId === to && event.globalOffset > message.globalOffset
      && event.payload.boundaryMessageIds?.includes(message.payload.message.messageId))),
  };
}

function matchesEvidence(text: string, expected: Readonly<Record<string, number>>): boolean {
  try {
    const payload: unknown = JSON.parse(text);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      && "type" in payload && payload.type === "checkout.evidence"
      && Object.keys(expected).length > 0
      && Object.entries(expected).every(([key, value]) => (
        Object.hasOwn(payload, key) && (payload as Record<string, unknown>)[key] === value
      ));
  } catch {
    return false;
  }
}

export function teamCancellationChecks(events: readonly AnyEvent[], runId: string, teamId: string) {
  const scoped = events.filter((event) => event.runId === runId);
  const settled = scoped.filter((event): event is Extract<AnyEvent, { type: "team.member.settled" }> => (
    event.type === "team.member.settled" && event.payload.teamId === teamId
  ));
  const cancelled = scoped.find((event) => event.type === "team.cancelled" && event.payload.teamId === teamId);
  return {
    cancelRequested: scoped.some((event) => event.type === "team.cancel.requested" && event.payload.teamId === teamId),
    teamCancelled: cancelled !== undefined,
    cancelledOutcome: settled.some((event) => event.payload.outcome === "cancelled"),
    noLateSuccess: cancelled !== undefined && !settled.some((event) => (
      event.globalOffset > cancelled.globalOffset && event.payload.outcome === "succeeded"
    )),
  };
}
