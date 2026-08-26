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
    }, {
      mainModel: sessionModel,
      clock,
      createRunId: () => runId,
    });
    await session.reviseGoal(sharedGoal.statement);
    await session.submit({ inputId: "activation-input", text: message, images });
    await session.waitForIdle();
    await session.close();

    expect(projectMainRequest(sessionModel.requests[0]))
      .toEqual(projectMainRequest(oneShotModel.requests[0]));
    expect(oneShotModel.requests[0]?.signal).toBe(oneShotAbort.signal);
    expect(sessionModel.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(oneShotModel.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "grep",
      "find",
      "write_file",
      "edit",
      "bash",
    ]);
  });

  it("assembles the same sparse Teto sidecar contract around Main", async () => {
    const root = await temporaryRoot();
    const runId = "activation-teto-contract";
    const task = "Complete six bounded decisions";
    const sidecarGoal: Goal = { ...sharedGoal, statement: task };
    const policy = {
      tetoEnabled: true,
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
    await session.reviseGoal(sidecarGoal.statement);
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
    expect(projectSidecarContract(
      sessionMain,
      sessionTeto,
      sessionEvents,
    )).toEqual(projectSidecarContract(
      oneShotMain,
      oneShotTeto,
      oneShotEvents,
    ));
    expect(projectSidecarContract(oneShotMain, oneShotTeto, oneShotEvents)).toEqual({
      mainCalls: 6,
      mainModels: ["scripted-main"],
      mainSessionIds: [`${runId}:main`],
      mainTools: ["noop", "respond_to_advice"],
      tetoCalls: 1,
      tetoModels: ["scripted-teto"],
      tetoSessionIds: [`${runId}:teto:scripted-teto`],
      tetoOutputLimits: [64],
      tetoRegistered: 1,
      observations: 1,
      tetoCharges: 1,
      adviceMessages: 0,
    });

    expect(projectMainRequest(sessionTeto.requests[0]))
      .toEqual(projectMainRequest(oneShotTeto.requests[0]));
  });
});

function projectMainRequest(request: ModelRequest | undefined): Omit<ModelRequest, "signal"> {
  if (request === undefined) throw new Error("Main request was not captured");
  const { signal: _signal, ...observable } = request;
  return observable;
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
    mainTools: main.requests[0]?.tools.map((tool) => tool.name) ?? [],
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
    teto: new ScriptedModel([() => {
      markTetoStarted?.();
      return response('{"action":"silent"}', 150, 20);
    }]),
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
