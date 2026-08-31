import { describe, expect, it } from "vitest";

import {
  CROSS_RUN_MAX_FUTURE_SKEW_MS,
  CROSS_RUN_MAX_INLINE_BYTES,
  CrossRunProtocolError,
  assertCrossRunReceiptMatchesEnvelope,
  createCrossRunMessageId,
  createCrossRunReceiptId,
  createCrossRunRouteId,
  crossRunFactFromMarker,
  crossRunFactMarker,
  envelopeToA2AMessage,
  normalizeCrossRunSendRequest,
  normalizeEnvelope,
  normalizeSenderIdentity,
  normalizeTarget,
  normalizeReceipt,
  verifyCrossRunArtifact,
} from "../../src/a2a/index.js";
import type { CrossRunEndpoint, CrossRunEnvelope } from "../../src/domain/types.js";
import { sha256 } from "../../src/ledger/hash.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const source: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  runId: "run-a",
  laneId: "main",
};
const target: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-b",
  runId: "run-b",
  laneId: "worker",
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: { relationship: "direct", id: target.runId },
    payload: { type: "message.inform", text: "hello" },
    conversationId: "conversation-1",
    threadId: "thread-1",
    correlationId: "correlation-1",
    idempotencyKey: "message-1",
    visibility: "run",
    priority: 2,
    ...overrides,
  };
}

function sender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: source,
    proof: { kind: "attach", authenticated: true, token: "opaque-token" },
    ...overrides,
  };
}

function envelopeFromRequest(input = request()): CrossRunEnvelope {
  const normalized = normalizeCrossRunSendRequest(input, { now });
  const routeId = createCrossRunRouteId(source, target, normalized.idempotencyKey);
  const messageId = createCrossRunMessageId(routeId, normalized);
  return normalizeEnvelope({
    protocolVersion: 1,
    messageId,
    routeId,
    source,
    target,
    relationship: "direct",
    conversationId: normalized.conversationId,
    threadId: normalized.threadId,
    correlationId: normalized.correlationId,
    idempotencyKey: normalized.idempotencyKey,
    createdAt: normalized.createdAt ?? now.toISOString(),
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
    visibility: normalized.visibility,
    priority: normalized.priority,
    payload: normalized.payload,
    artifacts: [],
  });
}

describe("cross-Run A2A contract", () => {
  it("rejects forged fields, wildcard selectors, and malformed sender proofs", () => {
    expect(() => normalizeCrossRunSendRequest({ ...request(), from: "worker" }, { now }))
      .toThrow(CrossRunProtocolError);
    expect(() => normalizeTarget({ relationship: "direct", id: "*" })).toThrow(/wildcard/iu);
    expect(() => normalizeTarget({ relationship: "direct", id: "all" })).toThrow(/wildcard/iu);
    expect(() => normalizeSenderIdentity(sender({ proof: { kind: "lease", authenticated: false, token: "x" } })))
      .toThrow(/authenticated/iu);
  });

  it("measures inline content in UTF-8 bytes at the exact boundary", () => {
    const exact = "x".repeat(CROSS_RUN_MAX_INLINE_BYTES);
    expect(normalizeCrossRunSendRequest(request({ payload: { type: "message.inform", text: exact } }), { now }))
      .toMatchObject({ payload: { text: exact } });
    expect(() => normalizeCrossRunSendRequest(
      request({ payload: { type: "message.inform", text: `${exact}x` } }),
      { now },
    )).toThrow(/UTF-8/iu);
    const unicode = "🙂".repeat(Math.ceil(CROSS_RUN_MAX_INLINE_BYTES / 4) + 1);
    expect(() => normalizeCrossRunSendRequest(
      request({ payload: { type: "message.inform", text: unicode } }),
      { now },
    )).toThrow(/UTF-8/iu);
  });

  it("allows only bounded future skew and rejects control characters", () => {
    const nearFuture = new Date(now.getTime() + CROSS_RUN_MAX_FUTURE_SKEW_MS).toISOString();
    expect(normalizeCrossRunSendRequest(request({ createdAt: nearFuture }), { now }).createdAt)
      .toBe(nearFuture);
    const tooFar = new Date(now.getTime() + CROSS_RUN_MAX_FUTURE_SKEW_MS + 1).toISOString();
    expect(() => normalizeCrossRunSendRequest(request({ createdAt: tooFar }), { now }))
      .toThrow(/future/iu);
    expect(() => normalizeCrossRunSendRequest(
      request({ payload: { type: "message.inform", text: "bad\u0000text" } }),
      { now },
    )).toThrow(/control/iu);
  });

  it("validates structured payloads before routing", () => {
    expect(() => normalizeCrossRunSendRequest(request({
      payload: { type: "task.accept" },
    }), { now })).toThrow(/taskId/iu);
    expect(() => normalizeCrossRunSendRequest(request({
      payload: { type: "task.accept", taskId: "task-1", extra: true },
    }), { now })).toThrow(/not allowed/iu);
  });

  it("binds deterministic route/message identities and rejects forged envelopes", () => {
    const envelope = envelopeFromRequest();
    expect(envelopeToA2AMessage(envelope)).toMatchObject({
      messageId: envelope.messageId,
      runId: target.runId,
      from: source.laneId,
      to: target.laneId,
      routeId: envelope.routeId,
    });
    expect(() => normalizeEnvelope({ ...envelope, routeId: "forged-route" })).toThrow(/routeId/iu);
    expect(() => normalizeEnvelope({ ...envelope, messageId: "forged-message" })).toThrow(/messageId/iu);
  });

  it("round-trips redaction-safe fact markers and verifies artifact bytes", () => {
    const envelope = envelopeFromRequest();
    const fact = { kind: "outbox.pending" as const, envelope, recordedAt: now.toISOString() };
    expect(crossRunFactFromMarker(crossRunFactMarker(fact))).toEqual(fact);
    const bytes = new TextEncoder().encode("artifact");
    const ref = {
      id: sha256(bytes),
      contentHash: sha256(bytes),
      mediaType: "text/plain",
      byteLength: bytes.byteLength,
    };
    expect(() => verifyCrossRunArtifact(bytes, ref)).not.toThrow();
    expect(() => verifyCrossRunArtifact(new TextEncoder().encode("tampered"), ref)).toThrow(/hash|length/iu);
  });

  it("binds terminal receipt semantics to the trusted envelope", () => {
    const envelope = envelopeFromRequest();
    const receipt = {
      protocolVersion: 1 as const,
      receiptId: createCrossRunReceiptId(envelope.routeId, "queued"),
      routeId: envelope.routeId,
      messageId: envelope.messageId,
      idempotencyKey: envelope.idempotencyKey,
      source: envelope.source,
      target: envelope.target,
      relationship: envelope.relationship,
      status: "queued" as const,
      recordedAt: now.toISOString(),
    };
    expect(() => assertCrossRunReceiptMatchesEnvelope(receipt, envelope)).not.toThrow();
    expect(() => assertCrossRunReceiptMatchesEnvelope(
      { ...receipt, messageId: "forged-message" },
      envelope,
    )).toThrow(/match/iu);
    expect(() => normalizeReceipt({
      ...receipt,
      status: "rejected",
      receiptId: createCrossRunReceiptId(envelope.routeId, "rejected"),
    })).toThrow(/reason/iu);
  });
});
