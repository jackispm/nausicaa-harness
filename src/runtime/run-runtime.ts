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
  AuxiliaryMode,
} from "../domain/types.js";
import { type UserImage, validateUserImages } from "../domain/images.js";
import {
  DEFAULT_MAIN_OUTPUT_TOKENS,
  MAX_MAIN_OUTPUT_TOKENS,
  mainStepAllowance,
} from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../fukai/index.js";
import { JsonlLedger, type Ledger } from "../ledger/index.js";
import { createOpenRouterModelPort } from "../model/index.js";
import {
  projectRunMetrics,
  type RunMetrics,
} from "../observability/index.js";
import {
  FileContentAddressedStore,
  type ContentAddressedStore,
} from "../store/index.js";
import { IntentNavigator, ObservationFrameBuilder } from "../teto/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import { createAdviceResponseTool } from "./advice-tool.js";
import { MainLoop } from "./main-loop.js";
import { persistedErrorText } from "./redaction.js";
import {
  commitRunCheckpoint,
  recoverRun,
  resolvePendingToolOperation,
  type RunRecoveryState,
} from "./recovery.js";
import { resolveRunPolicy } from "./run-policy.js";
import { TetoScheduler } from "./teto-scheduler.js";
import type { TetoAdviceDelivery } from "./teto-scheduler.js";
import { ReflectionScheduler } from "./reflection-scheduler.js";

export interface RunExecutionRequest {
  workspace: string;
  dataDir: string;
  model: string;
  tetoModel?: string;
  reflectionModel?: string;
  /** Evaluation-only auxiliary topology. Defaults to Teto when enabled by policy. */
  auxiliaryMode?: AuxiliaryMode;
  adviceDelivery?: TetoAdviceDelivery;
  message?: string;
  images?: UserImage[];
  goal?: Goal;
  resumeRunId?: string;
  resolveOperationId?: string;
  policy?: Partial<RunPolicy>;
  maxOutputTokens?: number;
  allowWrite?: boolean;
  allowShell?: boolean;
  signal?: AbortSignal;
}

export interface RunExecutionDeps {
  mainModel?: ModelPort;
  tetoModel?: ModelPort;
  reflectionModel?: ModelPort;
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
  metrics: RunMetrics;
  stateDir: string;
  blocker?: "model-output-limit" | "run-budget-or-step-limit" | "resumable-boundary";
}

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
  let scheduler: TetoScheduler | ReflectionScheduler | undefined;

  try {
    const sink = new ObservableEventSink(ledger, deps.onEvent);
    const store = await FileContentAddressedStore.open(resolve(stateDir, "store"));
    if (request.resolveOperationId !== undefined) {
      await resolvePendingToolOperation(
        ledger,
        store,
        runId,
        request.resolveOperationId,
        { clock },
      );
    }
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
        metrics: projectRunMetrics(recovered.events, runId),
        stateDir,
      };
    }

    const requestedAuxiliaryMode = request.auxiliaryMode
      ?? (request.policy?.tetoEnabled === false ? "none" : "teto");
    const setup = recovered === undefined
      ? await createNewRun(sink, request, runId, workspace, clock, requestedAuxiliaryMode)
      : await resumeExistingRun(sink, recovered, clock);
    const policy = setup.policy;
    const auxiliaryMode = request.auxiliaryMode
      ?? policy.auxiliaryMode
      ?? (policy.tetoEnabled ? "teto" : "none");
    const adviceDelivery = request.adviceDelivery
      ?? policy.tetoAdviceDelivery
      ?? "live";
    if (
      recovered !== undefined
      && request.auxiliaryMode !== undefined
      && policy.auxiliaryMode !== undefined
      && request.auxiliaryMode !== policy.auxiliaryMode
    ) {
      throw new Error("Cannot change auxiliaryMode while resuming a Run");
    }
    if (
      recovered !== undefined
      && request.adviceDelivery !== undefined
      && policy.tetoAdviceDelivery !== undefined
      && request.adviceDelivery !== policy.tetoAdviceDelivery
    ) {
      throw new Error("Cannot change adviceDelivery while resuming a Run");
    }
    const priorTokens = totalTokens(setup.priorUsage);
    const remainingModelTokens = Math.max(0, policy.maxModelTokens - priorTokens);
    const legacyStepLimitExhausted = "maxMainSteps" in policy
      && setup.startStep > mainStepAllowance(policy);
    if (remainingModelTokens === 0 || legacyStepLimitExhausted) {
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
      const metrics = projectRunMetrics(await ledger.read({ runId }), runId);
      return {
        runId,
        finalText: "",
        completed: false,
        steps: 0,
        usage: emptyUsage(),
        metrics,
        stateDir,
        blocker: "run-budget-or-step-limit",
      };
    }

    const mainModel = deps.mainModel ?? createOpenRouterModelPort();
    const inbox = new A2AInbox({
      sink,
      events: setup.events,
      clock,
    });
    const tools = [...(deps.tools ?? createWorkspaceTools({
      allowWrite: request.allowWrite === true,
      allowShell: request.allowShell === true,
      protectedPaths: [resolve(request.dataDir)],
    }))];
    if (auxiliaryMode === "teto") {
      if (adviceDelivery === "live") tools.push(createAdviceResponseTool(inbox));
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
        policy: { ...policy, tetoEnabled: true },
        events: setup.events,
        clock,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        adviceDelivery,
      });
    } else if (auxiliaryMode === "reflection") {
      scheduler = new ReflectionScheduler({
        eventSink: sink,
        modelPort: deps.reflectionModel ?? deps.tetoModel ?? mainModel,
        store,
        runId,
        goal: setup.goal,
        model: request.reflectionModel ?? request.tetoModel ?? request.model,
        policy,
        events: setup.events,
        clock,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }

    const lastModelCompletion = [...setup.events].reverse().find((event): event is Extract<
      AnyEvent,
      { type: "model.completed" }
    > => event.type === "model.completed");
    let outputContinuationMessageId = request.resumeRunId !== undefined
      && lastModelCompletion?.payload.stopReason === "length"
      ? `output-limit-continuation:${lastModelCompletion.eventId}`
      : undefined;

    const loop = new MainLoop({
      model: mainModel,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: sink,
      tools,
      clock,
      ...(outputContinuationMessageId === undefined && scheduler === undefined
        ? {}
        : {
            beforeStep: async () => {
              const continuation = outputContinuationMessageId === undefined
                ? []
                : [{
                    kind: "runtime-notice" as const,
                    source: "run-runtime",
                    content: "The previous assistant response reached the model output limit. Continue exactly where it stopped without repeating completed material.",
                    messageId: outputContinuationMessageId,
                  }];
              outputContinuationMessageId = undefined;
              return [
                ...continuation,
                ...await (
                  scheduler !== undefined && "beforeMainStep" in scheduler
                    ? scheduler.beforeMainStep()
                    : Promise.resolve([])
                ),
              ];
            },
            ...(scheduler === undefined
              ? {}
              : { afterStep: (context) => scheduler!.enqueue(context) }),
          }),
    });

    try {
      const result = await loop.run({
        runId,
        goal: setup.goal,
        model: request.model,
        workspace: setup.workspace,
        policy: { ...policy, maxModelTokens: remainingModelTokens },
        ...(request.message === undefined && (request.images?.length ?? 0) === 0
          ? {}
          : { initialMessage: request.message ?? "" }),
        ...(request.images === undefined
          ? {}
          : { initialImages: structuredClone(request.images) }),
        startStep: setup.startStep,
        upperWatermark: setup.upperWatermark,
        conversationRefs: setup.conversationRefs,
        maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (scheduler !== undefined) {
        await settlesWithin(scheduler.drain(), 25);
      }
      const blocker: RunExecutionResult["blocker"] = result.completed
        ? undefined
        : result.stopReason === "length"
          ? "model-output-limit"
          : "resumable-boundary";
      await appendLaneStatus(
        sink,
        runId,
        "main",
        result.completed ? "completed" : "waiting",
        result.completed
          ? undefined
          : blocker === "model-output-limit"
            ? "Model output limit reached"
            : "Main stopped at a resumable boundary",
        `main:status:${result.completed ? "completed" : "waiting"}:${setup.startStep}`,
        clock,
      );
      await scheduler?.stop();
      await commitRunCheckpoint(ledger, runId);
      const metrics = projectRunMetrics(await ledger.read({ runId }), runId);
      return {
        runId,
        finalText: result.finalText,
        completed: result.completed,
        steps: result.steps,
        usage: result.usage,
        metrics,
        stateDir,
        ...(blocker === undefined ? {} : { blocker }),
      };
    } catch (error: unknown) {
      await scheduler?.stop();
      const message = persistedErrorText(error, "Run failed");
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
    await scheduler?.stop().catch(() => undefined);
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
  auxiliaryMode: AuxiliaryMode,
): Promise<RunSetup> => {
  if (request.message === undefined && (request.images?.length ?? 0) === 0) {
    throw new Error("A new Run requires a task message or image");
  }
  const task = request.message ?? "Analyze the attached image(s)";
  const goal = request.goal ?? {
    version: 1,
    statement: task,
    successCriteria: ["Produce a grounded result for the requested task"],
    hardConstraints: [],
  };
  const policy = resolveRunPolicy({
    ...request.policy,
    ...(request.auxiliaryMode === undefined
      ? {}
      : { auxiliaryMode: request.auxiliaryMode }),
    ...(request.adviceDelivery === undefined
      ? {}
      : { tetoAdviceDelivery: request.adviceDelivery }),
    ...(auxiliaryMode === "teto"
      ? { tetoEnabled: true }
      : auxiliaryMode === "reflection" || auxiliaryMode === "none"
        ? { tetoEnabled: false }
        : {}),
  });
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
  if (auxiliaryMode === "teto") {
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
  if (auxiliaryMode === "reflection") {
    await sink.append({
      runId,
      laneId: "reflection",
      type: "lane.registered",
      payload: { kind: "reflection" },
      correlationId: `run:${runId}`,
      idempotencyKey: "lane:reflection:registered",
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
      try {
        void Promise.resolve(this.#onEvent?.(event as AnyEvent)).catch(() => undefined);
      } catch {
        // Observation is best-effort; the Ledger append is already committed.
      }
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
  if (
    request.auxiliaryMode !== undefined
    && request.auxiliaryMode !== "none"
    && request.auxiliaryMode !== "teto"
    && request.auxiliaryMode !== "reflection"
  ) {
    throw new Error("auxiliaryMode must be none, teto, or reflection");
  }
  try {
    validateUserImages(request.images);
  } catch (error: unknown) {
    throw new Error("Run images are invalid", { cause: error });
  }
  if (
    request.resumeRunId === undefined
    && request.message === undefined
    && (request.images?.length ?? 0) === 0
  ) {
    throw new Error("A new Run requires a task message or image");
  }
  if (request.images !== undefined && request.message === undefined && request.resumeRunId !== undefined) {
    throw new Error("Images submitted while resuming require a task message");
  }
  if (request.resolveOperationId !== undefined && request.resumeRunId === undefined) {
    throw new Error("resolveOperationId requires resumeRunId");
  }
  if (request.resolveOperationId !== undefined && request.resolveOperationId.length === 0) {
    throw new Error("resolveOperationId must not be empty");
  }
  if (
    request.maxOutputTokens !== undefined
    && (
      !Number.isSafeInteger(request.maxOutputTokens)
      || request.maxOutputTokens < 1
      || request.maxOutputTokens > MAX_MAIN_OUTPUT_TOKENS
    )
  ) {
    throw new RangeError(
      `maxOutputTokens must be an integer from 1 to ${MAX_MAIN_OUTPUT_TOKENS}`,
    );
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

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const settlesWithin = async (
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> => Promise.race([
  promise.then(() => true, () => true),
  delay(milliseconds).then(() => false),
]);
