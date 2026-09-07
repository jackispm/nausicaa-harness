import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTool,
  AnyEvent,
  Clock,
  Goal,
  ModelRequest,
  ModelResponse,
  UserImage,
} from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel, type ScriptedModelStep } from "../../src/model/index.js";
import { executeRun, SessionController } from "../../src/runtime/index.js";
import type { WorkspaceCommandSandboxOptions } from "../../src/tools/index.js";

const roots: string[] = [];
const clock: Clock = {
  now: () => new Date("2026-08-26T00:00:00.000Z"),
};
const sharedGoal: Goal = {
  version: 1,
  statement: "Inspect the supplied workspace evidence",
  successCriteria: ["Address each explicit user request with a grounded result"],
  hardConstraints: [],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("runtime activation parity", () => {
  it("gives the workspace profile one sandboxed foreground Bash without jobs or network", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "workspace-state");
    const model = new ScriptedModel([{
      ...response(""),
      stopReason: "toolUse",
      toolCalls: [{
        id: "workspace-bash-call",
        name: "bash",
        arguments: { command: "printf workspace" },
      }],
    }, response("done")]);
    let factoryCalls = 0;
    let availabilityCalls = 0;
    let executeCalls = 0;
    let sandboxOptions: WorkspaceCommandSandboxOptions | undefined;

    const result = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted-main",
      message: "Inspect and update this workspace",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 2 },
      allowWrite: true,
      allowShell: false,
      allowNetwork: false,
    }, {
      mainModel: model,
      createWorkspaceCommandSandbox: (options) => {
        factoryCalls += 1;
        sandboxOptions = options;
        return {
          availability() {
            availabilityCalls += 1;
            return { available: true, backend: "macos-seatbelt" };
          },
          async execute(input) {
            executeCalls += 1;
            expect(input).toMatchObject({
              command: "printf workspace",
              cwd: root,
            });
            return shellExecution("workspace");
          },
        };
      },
    });

    expect(result.completed).toBe(true);
    expect({ factoryCalls, availabilityCalls, executeCalls }).toEqual({
      factoryCalls: 1,
      availabilityCalls: 1,
      executeCalls: 1,
    });
    expect(sandboxOptions?.protectedPaths).toEqual([dataDir]);
    const names = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("bash");
    expect(names).toContain("write_file");
    expect(names).not.toContain("process_start");
    expect(names).not.toContain("web_fetch");
  });

  it("fails closed by omitting workspace Bash when the OS sandbox is unavailable", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("done")]);
    let executeCalls = 0;

    await executeRun({
      workspace: root,
      dataDir: join(root, "unavailable-state"),
      model: "scripted-main",
      message: "Inspect and update this workspace",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 1 },
      allowWrite: true,
      allowShell: false,
      allowNetwork: false,
    }, {
      mainModel: model,
      createWorkspaceCommandSandbox: () => ({
        availability: () => ({ available: false, reason: "no OS sandbox" }),
        execute: async () => {
          executeCalls += 1;
          return shellExecution("must not run");
        },
      }),
    });

    const names = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("process_start");
    expect(executeCalls).toBe(0);
  });

  it("does not construct a workspace sandbox for read-only, custom, or host-shell tools", async () => {
    const root = await temporaryRoot();
    let factoryCalls = 0;
    const failIfConstructed = () => {
      factoryCalls += 1;
      throw new Error("workspace sandbox must not be constructed");
    };

    const readOnlyModel = new ScriptedModel([response("read-only")]);
    await executeRun({
      workspace: root,
      dataDir: join(root, "read-only-state"),
      model: "scripted-main",
      message: "Inspect",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 1 },
    }, {
      mainModel: readOnlyModel,
      createWorkspaceCommandSandbox: failIfConstructed,
    });

    const fullAccessModel = new ScriptedModel([response("full-access")]);
    await executeRun({
      workspace: root,
      dataDir: join(root, "full-access-state"),
      model: "scripted-main",
      message: "Inspect",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 1 },
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
    }, {
      mainModel: fullAccessModel,
      createWorkspaceCommandSandbox: failIfConstructed,
    });

    const customModel = new ScriptedModel([response("custom")]);
    await executeRun({
      workspace: root,
      dataDir: join(root, "custom-state"),
      model: "scripted-main",
      message: "Inspect",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 1 },
      allowWrite: true,
    }, {
      mainModel: customModel,
      tools: [noopTool],
      createWorkspaceCommandSandbox: failIfConstructed,
    });

    expect(factoryCalls).toBe(0);
    expect(readOnlyModel.requests[0]?.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(fullAccessModel.requests[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "bash",
      "process_start",
      "web_fetch",
    ]));
    expect(customModel.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "noop",
      "agent_awareness",
      "team_create",
      "team_status",
      "team_cancel",
      "team_reduce",
      "team_present",
      "agent_message",
      "delegate_task",
    ]);
  });

  it("assembles the same observable Main request for one-shot and Session runtimes", async () => {
    const root = await temporaryRoot();
    const runId = "activation-main-contract";
    const message = "Inspect package metadata and this screenshot";
    const images = [image("activation-contract-image")];
    const oneShotModel = new ScriptedModel([response("one-shot complete")]);
    const sessionModel = new ScriptedModel([response("session complete")]);
    const oneShotAbort = new AbortController();
    const policy = {
      tetoEnabled: false,
      maxMainStepsPerActivation: 2,
      maxModelTokens: 20_000,
    } as const;

    await executeRun({
      workspace: root,
      dataDir: join(root, "one-shot-state"),
      model: "scripted-main",
      message,
      images,
      goal: sharedGoal,
      policy,
      maxOutputTokens: 8_192,
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
      signal: oneShotAbort.signal,
    }, {
      mainModel: oneShotModel,
      clock,
      createRunId: () => runId,
    });

    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "session-state"),
      model: "scripted-main",
      policy,
      maxOutputTokens: 8_192,
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
    }, {
      mainModel: sessionModel,
      clock,
      createRunId: () => runId,
    });
    await session.submit({ inputId: "activation-input", text: message, images });
    await session.waitForIdle();
    await session.close();

    expect(projectMainRequest(sessionModel.requests[0]))
      .toEqual(projectMainRequest(oneShotModel.requests[0]));
    expect(oneShotModel.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(oneShotModel.requests[0]?.signal).not.toBe(oneShotAbort.signal);
    expect(oneShotModel.requests[0]?.signal?.aborted).toBe(false);
    expect(sessionModel.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(oneShotModel.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "read_image",
      "web_fetch",
      "web_search",
      "write_file",
      "edit",
      "apply_patch",
      "directory_create",
      "path_copy",
      "path_move",
      "path_delete",
      "bash",
      "process_start",
      "process_status",
      "process_output",
      "process_kill",
      "process_list",
      "agent_awareness",
      "team_create",
      "team_status",
      "team_cancel",
      "team_reduce",
      "team_present",
      "agent_message",
      "delegate_task",
    ]);
  });

  it("assembles the same unified Teto lane contract around Main", async () => {
    const root = await temporaryRoot();
    const runId = "activation-teto-contract";
    const task = "Complete six bounded decisions";
    const sidecarGoal: Goal = { ...sharedGoal, statement: task };
    const policy = {
      tetoEnabled: true,
      tetoActivation: "automatic",
      maxMainStepsPerActivation: 6,
      maxModelTokens: 50_000,
    } as const;
    const oneShotModels = sidecarModels("one-shot");
    const sessionModels = sidecarModels("session");
    const oneShotMain = oneShotModels.main;
    const sessionMain = sessionModels.main;
    const oneShotTeto = oneShotModels.teto;
    const sessionTeto = sessionModels.teto;

    const oneShot = await executeRun({
      workspace: root,
      dataDir: join(root, "one-shot-teto-state"),
      model: "scripted-main",
      tetoModel: "scripted-teto",
      message: task,
      goal: sidecarGoal,
      policy,
    }, {
      mainModel: oneShotMain,
      tetoModel: oneShotTeto,
      tools: [noopTool],
      clock,
      createRunId: () => runId,
    });

    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "session-teto-state"),
      model: "scripted-main",
      tetoModel: "scripted-teto",
      policy,
    }, {
      mainModel: sessionMain,
      tetoModel: sessionTeto,
      tools: [noopTool],
      clock,
      createRunId: () => runId,
    });
    await session.submit({
      inputId: "teto-activation-input",
      text: task,
    });
    await session.waitForIdle();
    await session.close();

    const oneShotEvents = await readEvents(oneShot.stateDir, runId);
    const sessionEvents = await readEvents(
      join(root, "session-teto-state", "runs", runId),
      runId,
    );
    const sessionContract = projectSidecarContract(sessionMain, sessionTeto, sessionEvents);
    const oneShotContract = projectSidecarContract(oneShotMain, oneShotTeto, oneShotEvents);
    // Teto is deliberately non-blocking. Shutdown can observe one extra
    // provider pass in a persistent Session, so compare the stable lane
    // contract and assert activity independently below.
    expect(stripAsyncTailCounts(sessionContract)).toEqual(stripAsyncTailCounts(oneShotContract));
    const contract = projectSidecarContract(oneShotMain, oneShotTeto, oneShotEvents);
    expect(contract).toMatchObject({
      mainCalls: 6,
      mainModels: ["scripted-main"],
      mainSessionIds: [`${runId}:main`],
      mainTools: [
        "noop",
        "agent_awareness",
        "teto_start",
        "teto_stop",
        "teto_status",
        "team_create",
        "team_status",
        "team_cancel",
        "team_reduce",
        "team_present",
        "agent_message",
        "delegate_task",
      ],
      tetoModels: ["scripted-teto"],
      tetoSessionIds: [`${runId}:teto:scripted-teto`],
      tetoOutputLimits: [64],
      tetoRegistered: 1,
      observations: 0,
      adviceMessages: 0,
    });
    expect(contract.tetoCalls).toBeGreaterThanOrEqual(1);
    expect(contract.tetoCharges).toBeGreaterThanOrEqual(1);
    expect(sessionContract.tetoCalls).toBeGreaterThanOrEqual(1);
    expect(sessionContract.tetoCharges).toBeGreaterThanOrEqual(1);

    expect(projectMainRequest(sessionTeto.requests[0]))
      .toEqual(projectMainRequest(oneShotTeto.requests[0]));
  });
});

function projectMainRequest(request: ModelRequest | undefined): Omit<ModelRequest, "signal"> {
  if (request === undefined) throw new Error("Main request was not captured");
  const { signal: _signal, ...observable } = request;
  return {
    ...observable,
    // Session-owned Goal controls are a host capability, not part of the
    // common single-lane Main contract being compared here.
    tools: observable.tools.filter((tool) => (
      tool.name !== "get_goal"
      && tool.name !== "create_goal"
      && tool.name !== "update_goal"
    )),
    messages: observable.messages.filter((message) => (
      message.role !== "user"
      || !message.content.startsWith("Persistent thread Goal (host-controlled state;")
    )),
  };
}

function projectSidecarContract(
  main: ScriptedModel,
  teto: ScriptedModel,
  events: readonly AnyEvent[],
): Record<string, unknown> {
  return {
    mainCalls: main.callCount,
    mainModels: unique(main.requests.map((request) => request.model)),
    mainSessionIds: unique(main.requests.map((request) => request.sessionId)),
    mainTools: main.requests[0]?.tools
      .filter((tool) => !isSessionGoalTool(tool.name))
      .map((tool) => tool.name) ?? [],
    tetoCalls: teto.callCount,
    tetoModels: unique(teto.requests.map((request) => request.model)),
    tetoSessionIds: unique(teto.requests.map((request) => request.sessionId)),
    tetoOutputLimits: unique(teto.requests.map((request) => request.maxOutputTokens)),
    tetoRegistered: events.filter((event) => (
      event.type === "lane.registered" && event.laneId === "teto"
    )).length,
    observations: events.filter((event) => event.type === "teto.observed").length,
    tetoCharges: events.filter((event) => (
      event.type === "budget.charged" && event.laneId === "teto"
    )).length,
    adviceMessages: events.filter((event) => event.type === "message.sent").length,
  };
}

function isSessionGoalTool(name: string): boolean {
  return name === "get_goal" || name === "create_goal" || name === "update_goal";
}

function sidecarModels(prefix: string): {
  main: ScriptedModel;
  teto: ScriptedModel;
} {
  let markTetoStarted: (() => void) | undefined;
  const tetoStarted = new Promise<void>((resolve) => {
    markTetoStarted = resolve;
  });
  const steps: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
    ...response(`Step ${index + 1}`, 1_800, 200),
    stopReason: "toolUse",
    toolCalls: [{ id: `${prefix}-call-${index + 1}`, name: "noop", arguments: {} }],
  }));
  steps.push(async () => {
    await tetoStarted;
    return response("Done", 1_800, 200);
  });
  return {
    main: new ScriptedModel(steps),
    teto: new ScriptedModel(Array.from({ length: 16 }, (_, index) => () => {
      if (index === 0) markTetoStarted?.();
      return response('{"action":"silent"}', 150, 20);
    })),
  };
}

async function readEvents(stateDir: string, runId: string): Promise<AnyEvent[]> {
  const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
  try {
    return await ledger.read({ runId });
  } finally {
    await ledger.close();
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stripAsyncTailCounts(contract: Record<string, unknown>): Record<string, unknown> {
  const { tetoCalls: _tetoCalls, tetoCharges: _tetoCharges, ...stable } = contract;
  return stable;
}

const noopTool: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

function response(content: string, input = 20, output = 5): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
  };
}

function shellExecution(stdout: string) {
  const output = {
    content: stdout,
    truncated: false,
    truncatedBy: null,
    totalBytes: Buffer.byteLength(stdout, "utf8"),
    totalLines: stdout.length === 0 ? 0 : 1,
    outputBytes: Buffer.byteLength(stdout, "utf8"),
    outputLines: stdout.length === 0 ? 0 : 1,
  } as const;
  return {
    stdout: output,
    stderr: { ...output, content: "", totalBytes: 0, totalLines: 0, outputBytes: 0, outputLines: 0 },
    exitCode: 0,
    aborted: false,
    timedOut: false,
  };
}

function image(payload: string): UserImage {
  return {
    type: "image",
    data: Buffer.from(payload).toString("base64"),
    mimeType: "image/png",
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-activation-contract-"));
  roots.push(root);
  return root;
}
