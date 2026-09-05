import { describe, expect, it } from "vitest";

import {
  createCrossRunMessageId,
  createCrossRunReceiptId,
  createCrossRunRouteId,
} from "../../src/a2a/index.js";
import type {
  CrossRunEndpoint,
  CrossRunReceipt,
} from "../../src/domain/index.js";
import type { ToolExecutionContext } from "../../src/domain/ports.js";
import {
  createAgentMessageTool,
} from "../../src/runtime/index.js";
import type {
  CrossRunSenderIdentity,
  CrossRunSendRequest,
} from "../../src/a2a/index.js";

const source: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-source",
  runId: "run-source",
  laneId: "main",
};
const target: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-target",
  runId: "run-target",
  laneId: "worker",
};
const sender: CrossRunSenderIdentity = {
  endpoint: source,
  proof: { kind: "attach", authenticated: true, token: "opaque-secret-proof" },
  relationshipGrants: ["direct", "sibling"],
};
const context: ToolExecutionContext = {
  runId: source.runId,
  workspace: "/workspace",
  operationId: "operation-1",
};

function receiptFor(
  request: CrossRunSendRequest,
  status: CrossRunReceipt["status"] = "queued",
  diagnostic?: string,
): CrossRunReceipt {
  const routeId = createCrossRunRouteId(source, target, request.idempotencyKey);
  return {
    protocolVersion: 1,
    receiptId: createCrossRunReceiptId(routeId, status),
    routeId,
    messageId: createCrossRunMessageId(routeId, request),
    idempotencyKey: request.idempotencyKey,
    source,
    target,
    relationship: "direct",
    status,
    recordedAt: "2026-08-31T00:00:00.000Z",
    ...(status === "uncertain" ? { reason: "target-admission-failed" as const } : {}),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

describe("agent_message tool", () => {
  it("accepts a plain text shorthand and normalizes it to message.inform", async () => {
    const calls: CrossRunSendRequest[] = [];
    const tool = createAgentMessageTool({
      router: {
        send: async (request) => {
          calls.push(request);
          return receiptFor(request);
        },
      },
      sender,
      executionWorkspace: context.workspace,
    });

    const result = await tool.execute({
      target: { relationship: "direct", id: target.runId },
      text: "Please inspect this repository",
    }, context);

    expect(result.isError).toBe(false);
    expect(calls[0]?.payload).toEqual({
      type: "message.inform",
      text: "Please inspect this repository",
    });
    expect(tool.definition.parameters.required).toEqual(["target"]);
  });

  it("rejects mixing the plain text shorthand with a typed payload", async () => {
    const tool = createAgentMessageTool({
      router: { send: async (request) => receiptFor(request) },
      sender,
      executionWorkspace: context.workspace,
    });

    const result = await tool.execute({
      target: { relationship: "direct", id: target.runId },
      text: "plain",
      payload: { type: "message.inform", text: "typed" },
    }, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      error: { code: "invalid-request" },
    });
  });

  it("binds sender identity and defaults to the host-owned message scope", async () => {
    const calls: Array<{
      request: CrossRunSendRequest;
      sender: CrossRunSenderIdentity;
    }> = [];
    const tool = createAgentMessageTool({
      router: {
        send: async (request, authenticatedSender) => {
          calls.push({ request, sender: authenticatedSender });
          return receiptFor(request);
        },
      },
      sender,
      workspaceId: source.workspaceId,
      executionWorkspace: context.workspace,
      permissions: {
        relationships: ["direct"],
        visibilities: ["run"],
        maxPriority: 2,
      },
      conversationId: "host-conversation",
      threadId: "host-thread",
      correlationId: "host-correlation",
      visibility: "run",
      priority: 1,
    });

    const result = await tool.execute({
      target: { relationship: "direct", id: target.runId },
      payload: { type: "message.inform", text: "hello" },
    }, context);

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      request: {
        target: { relationship: "direct", id: target.runId },
        conversationId: "host-conversation",
        threadId: "host-thread",
        correlationId: "host-correlation",
        idempotencyKey: "agent-message:operation-1",
        visibility: "run",
        priority: 1,
      },
      sender: {
        endpoint: source,
        relationshipGrants: ["direct"],
      },
    });
    expect(result.content).not.toContain(sender.proof.token);
    expect(tool.definition.name).toBe("agent_message");
    expect(tool.metadata).toMatchObject({
      effect: "external",
      scope: "run",
      deterministic: false,
      concurrencySafe: false,
    });
  });

  it("rejects endpoint forgery, permission escalation, and scope reuse before routing", async () => {
    let sends = 0;
    const tool = createAgentMessageTool({
      router: {
        send: async (request) => {
          sends += 1;
          return receiptFor(request);
        },
      },
      sender,
      executionWorkspace: context.workspace,
      permissions: {
        relationships: ["direct"],
        visibilities: ["run"],
        maxPriority: 1,
      },
    });

    const forged = await tool.execute({
      target: { relationship: "direct", endpoint: target },
      payload: { type: "message.inform", text: "hello" },
    }, context);
    const escalated = await tool.execute({
      target: { relationship: "sibling", id: "sibling-1" },
      payload: { type: "message.inform", text: "hello" },
      visibility: "sensitive",
      priority: 100,
    }, context);
    const wrongScope = await tool.execute({
      target: { relationship: "direct", id: target.runId },
      payload: { type: "message.inform", text: "hello" },
    }, { ...context, runId: "another-run" });

    expect(JSON.parse(forged.content)).toMatchObject({
      error: { code: "selector-invalid" },
    });
    expect(JSON.parse(escalated.content)).toMatchObject({
      error: { code: "authorization-denied" },
    });
    expect(JSON.parse(wrongScope.content)).toMatchObject({
      error: { code: "scope-mismatch" },
    });
    expect(sends).toBe(0);
  });

  it("redacts unsafe transport diagnostics from failure receipts", async () => {
    const diagnostic = "socket failed at /private/path with opaque-secret-proof";
    const tool = createAgentMessageTool({
      router: {
        send: async (request) => receiptFor(request, "uncertain", diagnostic),
      },
      sender,
    });

    const result = await tool.execute({
      target: { relationship: "direct", id: target.runId },
      payload: { type: "message.inform", text: "hello" },
    }, context);
    const content = JSON.parse(result.content) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(content).toMatchObject({
      status: "uncertain",
      diagnostic: "delivery-diagnostic-redacted",
    });
    expect(result.content).not.toContain(diagnostic);
    expect(result.content).not.toContain(sender.proof.token);
  });
});
