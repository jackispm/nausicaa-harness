import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { A2AInbox } from "../a2a/index.js";
import type {
  AgentTool,
  Clock,
  ModelPort,
} from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../domain/events.js";
import type {
  ConversationMessage,
  Goal,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../fukai/index.js";
import { JsonlLedger, type Ledger } from "../ledger/index.js";
import { createOpenRouterModelPort } from "../model/index.js";
import {
  FileContentAddressedStore,
  type ContentAddressedStore,
} from "../store/index.js";
import { IntentNavigator, ObservationFrameBuilder } from "../teto/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import { createAdviceResponseTool } from "./advice-tool.js";
import { MainLoop } from "./main-loop.js";
import {
  commitRunCheckpoint,
  recoverRun,
  type RunRecoveryState,
} from "./recovery.js";
import { TetoScheduler } from "./teto-scheduler.js";

export interface RunExecutionRequest {
  workspace: string;
  dataDir: string;
  model: string;
  tetoModel?: string;
  message?: string;
  goal?: Goal;
  resumeRunId?: string;
  policy?: Partial<RunPolicy>;
  signal?: AbortSignal;
}

export interface RunExecutionDeps {
  mainModel?: ModelPort;
  tetoModel?: ModelPort;
  tools?: readonly AgentTool[];
  clock?: Clock;
  createRunId?: () => string;
  onEvent?: (event: AnyEvent) => void;
}

export interface RunExecutionResult {
  runId: string;
  finalText: string;
  completed: boolean;
  steps: number;
  usage: TokenUsage;
  stateDir: string;
}

const DEFAULT_POLICY: RunPolicy = {
  maxMainSteps: 24,
  maxModelTokens: 200_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

export const executeRun = async (
  request: RunExecutionRequest,
  deps: RunExecutionDeps = {},
): Promise<RunExecutionResult> => {
  validateRequest(request);
  const clock = deps.clock ?? systemClock;
  const workspace = resolve(request.workspace);
  const runId = request.resumeRunId ?? (deps.createRunId ?? randomUUID)();
  validateRunId(runId);
  const stateDir = resolve(request.dataDir, "runs", runId);
  const ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
  const sink = new ObservableEventSink(ledger, deps.onEvent);
  const store = await FileContentAddressedStore.open(resolve(stateDir, "store"));
  let scheduler: TetoScheduler | undefined;

  try {
    const recovered = request.resumeRunId === undefined
      ? undefined
      : await recoverRun(ledger, runId);
    if (recovered?.completedAnswerRef !== undefined) {
      return {
        runId,
        finalText: await readAssistantText(store, recovered.completedAnswerRef),
        completed: true,
        steps: 0,
        usage: emptyUsage(),
        stateDir,
      };
    }

    const setup = recovered === undefined
      ? await createNewRun(sink, request, runId, workspace, clock)
      : await resumeExistingRun(sink, recovered, clock);
    const policy = setup.policy;
    const priorTokens = totalTokens(setup.priorUsage);
    const remainingModelTokens = Math.max(0, policy.maxModelTokens - priorTokens);
    if (remainingModelTokens === 0 || setup.startStep > policy.maxMainSteps) {
      await appendLaneStatus(
        sink,
        runId,
        "main",
        "waiting",
        "Run budget or Step limit exhausted",
        `main:waiting:${setup.upperWatermark}`,
        clock,
      );
      await commitRunCheckpoint(ledger, runId);
      return {
        runId,
        finalText: "",
        completed: false,
        steps: 0,
        usage: emptyUsage(),
        stateDir,
      };
    }

    const mainModel = deps.mainModel ?? createOpenRouterModelPort();
    const inbox = new A2AInbox({
      sink,
      events: setup.events,
      clock,
    });
    const tools = [...(deps.tools ?? createWorkspaceTools())];
    if (policy.tetoEnabled) {
      tools.push(createAdviceResponseTool(inbox));
      const tetoModel = deps.tetoModel ?? mainModel;
      scheduler = new TetoScheduler({
        eventSink: sink,
        inbox,
        navigator: new IntentNavigator({
          modelPort: tetoModel,
          model: request.tetoModel ?? request.model,
          clock,
          maxAdviceOutputTokens: policy.tetoMaxOutputTokens,
        }),
        frameBuilder: new ObservationFrameBuilder({
          maxAdviceOutputTokens: policy.tetoMaxOutputTokens,
        }),
        runId,
        goal: setup.goal,
        model: request.tetoModel ?? request.model,
        policy,
        events: setup.events,
        clock,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }

    const loop = new MainLoop({
      model: mainModel,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: sink,
      tools,
      clock,
      ...(scheduler === undefined
        ? {}
        : {
            beforeStep: () => scheduler!.beforeMainStep(),
            afterStep: (context) => scheduler!.enqueue(context),
          }),
    });

    try {
      const result = await loop.run({
        runId,
        goal: setup.goal,
        model: request.model,
        workspace: setup.workspace,
        policy: { ...policy, maxModelTokens: remainingModelTokens },
        ...(request.message === undefined ? {} : { initialMessage: request.message }),
        startStep: setup.startStep,
        upperWatermark: setup.upperWatermark,
        conversationRefs: setup.conversationRefs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      await scheduler?.drain();
      await appendLaneStatus(
        sink,
        runId,
        "main",
        result.completed ? "completed" : "waiting",
        result.completed ? undefined : "Main stopped at a resumable boundary",
        `main:status:${result.completed ? "completed" : "waiting"}:${setup.startStep}`,
        clock,
      );
      await commitRunCheckpoint(ledger, runId);
      return {
        runId,
        finalText: result.finalText,
        completed: result.completed,
        steps: result.steps,
        usage: result.usage,
        stateDir,
      };
    } catch (error: unknown) {
      await scheduler?.drain();
      const message = sanitizedError(error);
      await appendLaneStatus(
        sink,
        runId,
        "main",
        "failed",
        message,
        `main:status:failed:${await ledger.watermark()}`,
        clock,
      );
      await sink.append({
        runId,
        laneId: "main",
        type: "run.failed",
        payload: { error: message },
        correlationId: `run:${runId}`,
        idempotencyKey: `run:failed:${await ledger.watermark()}`,
        visibility: "run",
        occurredAt: clock.now().toISOString(),
      });
      await commitRunCheckpoint(ledger, runId);
      throw error;
    }
  } finally {
    await scheduler?.drain().catch(() => undefined);
    await ledger.close();
  }
};

interface RunSetup {
  goal: Goal;
  policy: RunPolicy;
  workspace: string;
  startStep: number;
  upperWatermark: number;
  conversationRefs: RunRecoveryState["conversationRefs"];
  priorUsage: TokenUsage;
  events: AnyEvent[];
}

const createNewRun = async (
  sink: ObservableEventSink,
  request: RunExecutionRequest,
  runId: string,
  workspace: string,
  clock: Clock,
): Promise<RunSetup> => {
  if (request.message === undefined) {
    throw new Error("A new Run requires a task message");
  }
  const goal = request.goal ?? {
    version: 1,
    statement: request.message,
    successCriteria: ["Produce a grounded result for the requested task"],
    hardConstraints: [],
  };
  const policy = resolvePolicy(request.policy);
  await sink.append({
    runId,
    laneId: "main",
    type: "run.created",
    payload: { goal, workspace, policy },
    correlationId: `run:${runId}`,
    idempotencyKey: "run:created",
    visibility: "run",
    occurredAt: clock.now().toISOString(),
  });
  await sink.append({
    runId,
    laneId: "main",
    type: "lane.registered",
    payload: { kind: "main" },
    correlationId: `run:${runId}`,
    idempotencyKey: "lane:main:registered",
    visibility: "run",
  });
  if (policy.tetoEnabled) {
    await sink.append({
      runId,
      laneId: "teto",
      type: "lane.registered",
      payload: { kind: "intent-navigator" },
      correlationId: `run:${runId}`,
      idempotencyKey: "lane:teto:registered",
      visibility: "run",
    });
  }
  await appendLaneStatus(
    sink,
    runId,
    "main",
    "running",
    undefined,
    "main:status:running:initial",
    clock,
  );
  const events = await sink.ledger.read({ runId });
  return {
    goal,
    policy,
    workspace,
    startStep: 1,
    upperWatermark: await sink.ledger.watermark(),
    conversationRefs: [],
    priorUsage: emptyUsage(),
    events,
  };
};

const resumeExistingRun = async (
  sink: ObservableEventSink,
  recovered: RunRecoveryState,
  clock: Clock,
): Promise<RunSetup> => {
  await sink.append({
    runId: recovered.runId,
    laneId: "main",
    type: "run.resumed",
    payload: { fromOffset: recovered.upperWatermark },
    correlationId: `resume:${recovered.runId}`,
    idempotencyKey: `run:resumed:${recovered.upperWatermark}`,
    visibility: "run",
    occurredAt: clock.now().toISOString(),
  });
  await appendLaneStatus(
    sink,
    recovered.runId,
    "main",
    "running",
    undefined,
    `main:status:running:${recovered.upperWatermark}`,
    clock,
  );
  return {
    goal: recovered.goal,
    policy: recovered.policy,
    workspace: recovered.workspace,
    startStep: recovered.startStep,
    upperWatermark: await sink.ledger.watermark(),
    conversationRefs: recovered.conversationRefs,
    priorUsage: recovered.priorUsage,
    events: await sink.ledger.read({ runId: recovered.runId }),
  };
};

class ObservableEventSink {
  readonly ledger: Ledger;
  readonly #onEvent: RunExecutionDeps["onEvent"];
  readonly #seen = new Set<string>();

  constructor(ledger: Ledger, onEvent: RunExecutionDeps["onEvent"]) {
    this.ledger = ledger;
    this.#onEvent = onEvent;
  }

  async append<K extends EventType>(
    input: AppendEvent<K>,
  ): Promise<EventEnvelope<K>> {
    const event = await this.ledger.append(input);
    if (!this.#seen.has(event.eventId)) {
      this.#seen.add(event.eventId);
      this.#onEvent?.(event as AnyEvent);
    }
    return event;
  }
}

const appendLaneStatus = async (
  sink: ObservableEventSink,
  runId: string,
  laneId: string,
  status: "running" | "waiting" | "completed" | "failed",
  reason: string | undefined,
  idempotencyKey: string,
  clock: Clock,
): Promise<void> => {
  await sink.append({
    runId,
    laneId,
    type: "lane.status",
    payload: { status, ...(reason === undefined ? {} : { reason }) },
    correlationId: `run:${runId}`,
    idempotencyKey,
    visibility: "run",
    occurredAt: clock.now().toISOString(),
  });
};

const resolvePolicy = (input: Partial<RunPolicy> = {}): RunPolicy => {
  const policy = { ...DEFAULT_POLICY, ...input };
  if (!Number.isSafeInteger(policy.maxMainSteps) || policy.maxMainSteps < 1) {
    throw new RangeError("maxMainSteps must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1) {
    throw new RangeError("maxModelTokens must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.tetoMaxOutputTokens)
    || policy.tetoMaxOutputTokens < 1
  ) {
    throw new RangeError("tetoMaxOutputTokens must be a positive integer");
  }
  if (policy.tetoTokenRatio <= 0 || policy.tetoTokenRatio >= 1) {
    throw new RangeError("tetoTokenRatio must be between zero and one");
  }
  return policy;
};

const readAssistantText = async (
  store: ContentAddressedStore,
  ref: Parameters<ContentAddressedStore["get"]>[0],
): Promise<string> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(await store.get(ref)));
  if (
    value === null
    || typeof value !== "object"
    || (value as Partial<ConversationMessage>).role !== "assistant"
    || typeof (value as Partial<ConversationMessage>).content !== "string"
  ) {
    throw new Error("Completed Run answer artifact is not an assistant message");
  }
  return (value as Extract<ConversationMessage, { role: "assistant" }>).content;
};

const validateRequest = (request: RunExecutionRequest): void => {
  if (request.workspace.length === 0 || request.dataDir.length === 0) {
    throw new Error("workspace and dataDir are required");
  }
  if (request.model.length === 0) {
    throw new Error("model is required");
  }
  if (request.resumeRunId === undefined && request.message === undefined) {
    throw new Error("A new Run requires a task message");
  }
};

const validateRunId = (runId: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Run id contains unsupported characters");
  }
};

const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const sanitizedError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Run failed";
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sk-or-v1)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, 1_024);
};
