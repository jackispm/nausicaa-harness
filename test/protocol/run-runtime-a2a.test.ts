import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CrossRunEndpoint,
  ModelResponse,
} from "../../src/domain/index.js";
import type {
  CrossRunSenderIdentity,
  CrossRunTargetAdmissionInput,
  CrossRunTargetResolver,
} from "../../src/a2a/index.js";
import { executeRun, SessionController } from "../../src/runtime/index.js";
import { ScriptedModel } from "../../src/model/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeRun Cross-Run A2A composition", () => {
  it("binds an authenticated sender and durable source outbox to agent_message", async () => {
    const root = await temporaryRoot();
    const target: CrossRunEndpoint = {
      workspaceId: "workspace-a",
      sessionId: "session-target",
      runId: "target-run",
      laneId: "main",
    };
    const calls: string[] = [];
    const model = new ScriptedModel([
      {
        ...response("send a handoff"),
        stopReason: "toolUse",
        toolCalls: [{
          id: "message-call",
          name: "agent_message",
          arguments: {
            target: { relationship: "direct", id: target.runId },
            payload: { type: "message.inform", text: "handoff" },
          },
        }],
      },
      (request) => {
        const result = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "agent_message"
        ));
        expect(result?.content).toContain('"status":"queued"');
        return response("handoff queued");
      },
    ]);
    const senderFactory = ({ runId }: { runId: string }): CrossRunSenderIdentity => ({
      endpoint: {
        workspaceId: "workspace-a",
        sessionId: "session-source",
        runId,
        laneId: "main",
      },
      proof: { kind: "attach", authenticated: true, token: "host-proof" },
      relationshipGrants: ["direct"],
    });
    const resolver: CrossRunTargetResolver = {
      async resolve(selector, sender) {
        calls.push(`resolve:${selector.relationship}:${sender.endpoint.runId}`);
        return { endpoint: target, relationship: "direct", reachable: true, status: "idle" };
      },
    };
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Coordinate with the target Run",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "source-run",
      crossRun: {
        sender: senderFactory,
        routerOptions: {
          resolver,
          authorizer: {
            async authorize(input) {
              calls.push(`authorize:${input.operation}:${input.relationship}`);
              return { allowed: true };
            },
          },
          targetAdmission: {
            async admit(input: CrossRunTargetAdmissionInput) {
              calls.push(`admit:${input.envelope.target.runId}`);
              return { status: "queued", messageId: input.envelope.messageId };
            },
          },
          wake: {
            async wake() {
              calls.push("wake");
              return { status: "queued" };
            },
          },
        },
      },
    });

    expect(result).toMatchObject({ completed: true, finalText: "handoff queued" });
    expect(calls).toEqual([
      "resolve:direct:source-run",
      "authorize:send:direct",
      "admit:target-run",
      "wake",
    ]);
    const ledger = await readFile(join(result.stateDir, "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"type":"a2a.outbox.pending"');
    expect(ledger).toContain('"type":"a2a.outbox.receipt"');
    expect(ledger).not.toContain("host-proof");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain("agent_message");
  });

  it("does not advertise cross-Run messaging without host composition", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      {
        ...response("try message"),
        stopReason: "toolUse",
        toolCalls: [{
          id: "missing-message-tool",
          name: "agent_message",
          arguments: {
            target: { relationship: "parent" },
            payload: { type: "message.inform", text: "hello" },
          },
        }],
      },
      (request) => {
        expect(request.messages.findLast((message) => message.role === "tool")?.content)
          .toContain("Unknown tool: agent_message");
        return response("messaging unavailable");
      },
    ]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Do not message another Run",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "no-a2a-run",
    });

    expect(result).toMatchObject({ completed: true, finalText: "messaging unavailable" });
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("agent_message");
  });

  it("rejects a sender that is not bound to the active Run lane", async () => {
    const root = await temporaryRoot();
    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "fail closed",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
      createRunId: () => "active-run",
      crossRun: {
        sender: {
          endpoint: {
            workspaceId: "workspace-a",
            sessionId: "session-source",
            runId: "another-run",
            laneId: "main",
          },
          proof: { kind: "attach", authenticated: true, token: "proof" },
        },
        routerOptions: {
          resolver: { resolve: async () => {
            throw new Error("must not resolve");
          } },
        },
      },
    })).rejects.toThrow("sender endpoint does not match");
  });

  it("uses the same composition for an interactive Session Turn", async () => {
    const root = await temporaryRoot();
    const target: CrossRunEndpoint = {
      workspaceId: "workspace-a",
      sessionId: "session-target",
      runId: "interactive-target",
      laneId: "main",
    };
    const model = new ScriptedModel([
      {
        ...response("send"),
        stopReason: "toolUse",
        toolCalls: [{
          id: "interactive-message",
          name: "agent_message",
          arguments: {
            target: { relationship: "direct", id: target.runId },
            payload: { type: "message.inform", text: "interactive handoff" },
          },
        }],
      },
      response("sent"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "interactive-source",
      crossRun: {
        sender: ({ runId }) => ({
          endpoint: {
            workspaceId: "workspace-a",
            sessionId: "session-source",
            runId,
            laneId: "main",
          },
          proof: { kind: "attach", authenticated: true, token: "interactive-proof" },
          relationshipGrants: ["direct"],
        }),
        routerOptions: {
          resolver: {
            resolve: async () => ({ endpoint: target, relationship: "direct" }),
          },
          targetAdmission: {
            admit: async ({ envelope }) => ({
              status: "delivered",
              messageId: envelope.messageId,
            }),
          },
        },
      },
    });
    await session.submit({ inputId: "interactive-input", text: "Send a handoff" });
    await session.waitForIdle();
    expect(session.snapshot().status).toBe("idle");
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain("agent_message");
    expect(model.requests[1]?.messages.findLast((message) => (
      message.role === "tool" && message.toolName === "agent_message"
    ))?.content).toContain('"status":"delivered"');
    await session.close();
  });
});

const response = (content: string): ModelResponse => ({
  content,
  toolCalls: [],
  stopReason: "stop",
  usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-runtime-a2a-"));
  roots.push(root);
  return root;
};
