import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
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
  FukaiCompactionPolicy,
  Goal,
  LaneStatus,
  RunPolicy,
  TetoActivationMode,
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
import type { FukaiCompactionSelection } from "../fukai/types.js";
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
import {
  createWorkspaceTools,
  ProcessJobManager,
  WorkspaceCommandSandbox,
  type WorkspaceCommandSandboxOptions,
  type WebFetchProvider,
  type WebSearchProvider,
} from "../tools/index.js";
import {
  MainLoop,
  MainRunTokenBudgetExhaustedError,
  type MainLoopDeps,
} from "./main-loop.js";
import { persistedErrorText } from "./redaction.js";
import {
  commitRunCheckpoint,
  projectMainExecutionRecovery,
  recoverRun,
  resolvePendingToolOperation,
  type RunRecoveryState,
} from "./recovery.js";
import {
  normalizeFukaiCompactionPolicy,
  resolveRunPolicy,
} from "./run-policy.js";
import {
  createRuntimeFukaiCompaction,
  deriveRuntimePolicyVersion,
  instantiateRuntimeFukaiCompaction,
  prepareRuntimeFukaiCompaction,
  runtimeFukaiCompactionBudget,
  type RuntimeFukaiCompactionFactory,
} from "./fukai-compaction-runtime.js";
import { RunTokenBudget } from "./run-token-budget.js";
import {
  recoverRunTokenUsage,
  recoverRunTokenUsageByLane,
} from "./run-token-budget-recovery.js";
import { IntentNavigator, ObservationFrameBuilder } from "../teto/index.js";
import { createAdviceResponseTool } from "./advice-tool.js";
import { TetoScheduler, type TetoAdviceDelivery } from "./teto-scheduler.js";
import { TetoLaneScheduler } from "./teto-lane-scheduler.js";
import { TetoLaneController } from "./teto-lane-controller.js";
import { createAgentAwarenessTool } from "./agent-awareness-tool.js";
import { createTetoControlTools } from "./teto-control-tool.js";
import { TeamRuntime } from "./team-runtime.js";
import { createTeamTool } from "./team-tool.js";
import { projectRunAwareness } from "./run-awareness.js";
import { ReflectionScheduler } from "./reflection-scheduler.js";
import { createDelegateTaskTool } from "./delegate-task-tool.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import {
  projectCommittedBoundaryMessageIds,
  WorkerLaneScheduler,
} from "./worker-lane-scheduler.js";
import { WorkerTaskExecutor } from "./worker-task-executor.js";
import { shouldAdvertiseImageTools } from "./model-capabilities.js";
import {
  createCrossRunRuntimeTool,
  type CrossRunRuntimeComposition,
} from "./cross-run-runtime.js";
import {
  freezeWorkspaceEdgeToolSnapshot,
  type WorkspaceEdgeToolSnapshot,
} from "../mowe/workspace-catalog.js";
import {
  appendPermittedEdgeTools,
  captureEdgeTurnSnapshot,
  type EdgeTurnSnapshotProvider,
} from "./edge-runtime.js";
import { createRuntimeSkillCapability } from "./skill-tool.js";

export interface RunExecutionRequest {
  workspace: string;
  dataDir: string;
  model: string;
  tetoModel?: string;
  reflectionModel?: string;
  workerModel?: string;
  /** Evaluation-only auxiliary topology. Defaults to Teto when enabled by policy. */
  auxiliaryMode?: AuxiliaryMode;
  /** Manual leaves Teto dormant until Main calls `teto_start`. */
  tetoActivation?: TetoActivationMode;
  /** Opt-in bounded Worker lane; omitted or false preserves Main-only behavior. */
  workerEnabled?: boolean;
  /** Explicit Fukai capability settings; omitted keeps the legacy disabled path. */
  fukaiCompaction?: FukaiCompactionPolicy;
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
  /** Explicitly enable network-backed workspace tools for Main. */
  allowNetwork?: boolean;
  /** Registry snapshot captured before this Run/Turn; never refreshed mid-turn. */
  edgeSnapshot?: WorkspaceEdgeToolSnapshot;
  /** Optional composition seam; captured once before Main context assembly. */
  edgeSnapshotProvider?: EdgeTurnSnapshotProvider;
  /** Whether this one-shot activation owns and closes the provider. */
  closeEdgeCompositionOnClose?: boolean;
  signal?: AbortSignal;
}

export interface RunExecutionDeps {
  mainModel?: ModelPort;
  tetoModel?: ModelPort;
  reflectionModel?: ModelPort;
  workerModel?: ModelPort;
  tools?: readonly AgentTool[];
  /** Optional bounded read-only tools for Worker; defaults to the workspace set. */
  workerTools?: readonly AgentTool[];
  /** Optional provider seams for network-backed Main tools. */
  webFetchProvider?: WebFetchProvider;
  webSearchProvider?: WebSearchProvider;
  /**
   * Host-owned Cross-Run A2A composition. When present, Main receives the
   * `agent_message` capability bound to this Run's authenticated sender;
   * without it, no cross-Run capability is advertised.
   */
  crossRun?: CrossRunRuntimeComposition;
  /** Embedding seam for a captured edge snapshot when request data is shared. */
  edgeSnapshot?: WorkspaceEdgeToolSnapshot;
  edgeSnapshotProvider?: EdgeTurnSnapshotProvider;
  /** Defaults to true for backward-compatible one-shot ownership. */
  closeEdgeCompositionOnClose?: boolean;
  /** Host approval boundary for Main tools that explicitly require approval. */
  approveTool?: MainLoopDeps["approve"];
  /** Test/embedding seam for the OS-enforced workspace Bash boundary. */
  createWorkspaceCommandSandbox?: (
    options: WorkspaceCommandSandboxOptions,
  ) => Pick<WorkspaceCommandSandbox, "availability" | "execute">;
  /** Optional explicit selector for a previously committed Fukai capsule. */
  selectCompaction?: (context: {
    runId: string;
    laneId: string;
    goal: Goal;
    policyVersion: string;
    upperWatermark: number;
    signal?: AbortSignal;
  }) => Promise<FukaiCompactionSelection | undefined>;
  /** Test/plugin seam for the opt-in activation-scoped compaction adapter. */
  createCompactionRuntime?: RuntimeFukaiCompactionFactory;
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
  const closeEdgeCompositionOnClose = request.closeEdgeCompositionOnClose
    ?? deps.closeEdgeCompositionOnClose
    ?? true;
  const edgeSnapshotProvider = request.edgeSnapshotProvider ?? deps.edgeSnapshotProvider;
  const clock = deps.clock ?? systemClock;
  let edgeSnapshot: WorkspaceEdgeToolSnapshot | undefined;
  let workspace: string;
  let runId: string;
  let stateDir: string;
  let ledger: JsonlLedger;
  try {
    validateRequest(request);
    edgeSnapshot = request.edgeSnapshot === undefined && deps.edgeSnapshot === undefined
      ? undefined
      : freezeWorkspaceEdgeToolSnapshot(request.edgeSnapshot ?? deps.edgeSnapshot!);
    // Match Session's canonical workspace identity when the directory exists.
    // Keep a resolved fallback for legacy callers that create the workspace
    // later; this also keeps owned edge resources inside the cleanup boundary.
    workspace = await canonicalWorkspace(request.workspace);
    runId = request.resumeRunId ?? (deps.createRunId ?? randomUUID)();
    validateRunId(runId);
    stateDir = resolve(request.dataDir, "runs", runId);
    ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
  } catch (error: unknown) {
    if (closeEdgeCompositionOnClose) {
      try {
        await edgeSnapshotProvider?.close?.();
      } catch {
        // A failed preflight must not hide the original validation/open error.
      }
    }
    throw error;
  }
  let scheduler: TetoLaneController | TetoLaneScheduler | TetoScheduler | ReflectionScheduler | undefined;
  let workerScheduler: WorkerLaneScheduler | undefined;
  let teamRuntime: TeamRuntime | undefined;
  let processJobManager: ProcessJobManager | undefined;

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
    if (recovered !== undefined) {
      validateRequestedFukaiPolicy(request.fukaiCompaction, recovered.policy.fukaiCompaction);
    }
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
      ?? (request.policy?.tetoEnabled === false
        ? "none"
        : request.tetoActivation !== undefined
          ? request.tetoActivation === "manual" ? "none" : "teto"
          : request.policy?.tetoActivation !== undefined
            ? request.policy.tetoActivation === "manual" ? "none" : "teto"
            : request.policy?.maxMainSteps !== undefined
              ? "teto"
              : "none");
    const requestedWorkerEnabled = request.workerEnabled ?? request.policy?.workerEnabled;
    const setup = recovered === undefined
      ? await createNewRun(
          sink,
          request,
          runId,
          workspace,
          clock,
          requestedAuxiliaryMode,
          requestedWorkerEnabled,
        )
      : await resumeExistingRun(sink, recovered, clock);
    const policy = setup.policy;
    // `maxMainSteps` is the schema-v1 compatibility arm. New callers use the
    // activation field and receive the ordinary continuous Teto lane.
    const recoveredLegacyPolicy = "maxMainSteps" in policy;
    const useUnifiedTeto = request.auxiliaryMode === undefined
      && request.policy?.maxMainSteps === undefined
      && !recoveredLegacyPolicy;
    const auxiliaryMode = request.auxiliaryMode
      ?? policy.auxiliaryMode
      ?? (policy.tetoEnabled && policy.tetoActivation !== "manual" ? "teto" : "none");
    const adviceDelivery = request.adviceDelivery
      ?? policy.tetoAdviceDelivery
      ?? "live";
    const workerEnabled = request.workerEnabled
      ?? (request.policy?.workerEnabled !== undefined
        ? request.policy.workerEnabled
        : policy.workerEnabled === true);
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
    if (
      recovered !== undefined
      && requestedWorkerEnabled !== undefined
      && requestedWorkerEnabled !== (policy.workerEnabled === true)
    ) {
      throw new Error("Cannot change workerEnabled while resuming a Run");
    }
    // The root budget is the Run-wide aggregate. Auxiliary lanes use child
    // budgets, so recovered Teto usage must remain accounted for here.
    const recoveredUsage = recoverRunTokenUsage(setup.events, runId);
    const runTokenBudget = new RunTokenBudget(
      policy.maxModelTokens,
      totalTokens(recoveredUsage),
    );
    const policyVersion = deriveRuntimePolicyVersion(policy);
    const compactionEnabled = policy.fukaiCompaction?.enabled === true
      && policy.fukaiCompaction.provider === "pi-ai";
    const compactionModel = compactionEnabled
      ? deps.mainModel ?? createOpenRouterModelPort()
      : undefined;
    const compactionRuntime = compactionModel === undefined
      ? undefined
      : instantiateRuntimeFukaiCompaction(
          policy,
          deps.createCompactionRuntime ?? createRuntimeFukaiCompaction,
          {
            ledger: sink,
            store,
            modelPort: compactionModel,
            model: request.model,
            tokenBudget: runTokenBudget,
            clock,
            policy,
          },
        );
    if (compactionRuntime !== undefined) {
      await prepareRuntimeFukaiCompaction(compactionRuntime, {
        runId,
        laneId: "main",
        goal: setup.goal,
        policyVersion,
        upperWatermark: setup.compactionUpperWatermark,
        conversationRefs: setup.conversationRefs,
        budget: runtimeFukaiCompactionBudget(policy),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }
    rethrowIfAborted(request.signal);
    const remainingModelTokens = runTokenBudget.availableTokens();
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

    const mainModel = compactionModel ?? deps.mainModel ?? createOpenRouterModelPort();
    const edgeProjection = await captureEdgeTurnSnapshot(
      edgeSnapshotProvider,
      edgeSnapshot,
      request.signal,
    );
    const mainAdvertisesImages = shouldAdvertiseImageTools(mainModel, request.model);
    const mainUpperWatermark = compactionRuntime === undefined
      ? setup.upperWatermark
      : await ledger.watermark();
    const selectCompaction = deps.selectCompaction
      ?? (compactionRuntime === undefined
        ? undefined
        : compactionRuntime.select.bind(compactionRuntime));
    const compactForPressure = deps.selectCompaction === undefined
      ? compactionRuntime?.compactIfNeeded?.bind(compactionRuntime)
      : undefined;
    const inbox = new A2AInbox({
      sink,
      events: setup.events,
      clock,
    });
    const crossRunTool = deps.crossRun === undefined
      ? undefined
      : await createCrossRunRuntimeTool(deps.crossRun, {
          runId,
          laneId: "main",
          workspace,
          ledger,
          store,
        });
    const hostShellEnabled = deps.tools === undefined && request.allowShell === true;
    const workspaceShellRequested = deps.tools === undefined
      && request.allowWrite === true
      && request.allowShell !== true
      && request.allowNetwork !== true;
    const workspaceCommandSandbox = workspaceShellRequested
      ? (deps.createWorkspaceCommandSandbox
          ?? ((options) => new WorkspaceCommandSandbox(options)))({
            protectedPaths: [resolve(request.dataDir)],
          })
      : undefined;
    const workspaceBashExecutor = workspaceCommandSandbox?.availability().available === true
      ? workspaceCommandSandbox.execute
      : undefined;
    if (hostShellEnabled) {
      processJobManager = new ProcessJobManager({
        protectedPaths: [resolve(request.dataDir)],
      });
    }
    const baseTools = deps.tools ?? createWorkspaceTools({
      allowWrite: request.allowWrite === true,
      allowShell: hostShellEnabled || workspaceBashExecutor !== undefined,
      ...(workspaceBashExecutor === undefined
        ? {}
        : { bashCommandExecutor: workspaceBashExecutor }),
      allowProcessJobs: hostShellEnabled,
      ...(processJobManager === undefined ? {} : { processJobManager }),
      allowImages: mainAdvertisesImages,
      allowNetwork: request.allowNetwork === true,
      ...(deps.webFetchProvider === undefined
        ? {}
        : { webFetchProvider: deps.webFetchProvider }),
      ...(deps.webSearchProvider === undefined
        ? {}
        : { webSearchProvider: deps.webSearchProvider }),
      protectedPaths: [resolve(request.dataDir)],
    });
    const tools: AgentTool[] = [...baseTools];
    if (crossRunTool !== undefined) {
      if (tools.some((tool) => tool.definition.name.trim() === crossRunTool.definition.name.trim())) {
        throw new Error("cross-Run agent_message capability collides with a host tool");
      }
      tools.push(crossRunTool);
    }
    const readAwareness = async () => projectRunAwareness(
      await ledger.read({ runId }),
      runId,
      clock.now().toISOString(),
    );
    // Explicit auxiliaryMode is the preregistered evaluation seam. Its model
    // tool matrix is frozen, so only the declared auxiliary capability may
    // affect the request surface.
    const evaluationAuxiliaryMode = request.auxiliaryMode !== undefined;
    if (auxiliaryMode === "teto" || (useUnifiedTeto && policy.tetoEnabled)) {
      const tetoModel = deps.tetoModel ?? mainModel;
      const tetoModelName = request.tetoModel ?? request.model;
      if (!useUnifiedTeto) {
        if (adviceDelivery === "live") tools.push(createAdviceResponseTool(inbox));
        scheduler = new TetoScheduler({
          eventSink: sink,
          inbox,
          navigator: new IntentNavigator({
            modelPort: tetoModel,
            model: tetoModelName,
            clock,
            maxAdviceOutputTokens: policy.tetoMaxOutputTokens,
          }),
          frameBuilder: new ObservationFrameBuilder({
            maxAdviceOutputTokens: policy.tetoMaxOutputTokens,
          }),
          runId,
          goal: setup.goal,
          model: tetoModelName,
          policy: { ...policy, tetoEnabled: true },
          events: setup.events,
          clock,
          runTokenBudget,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          adviceDelivery,
        });
      } else {
        const tetoTokenBudget = new RunTokenBudget(
          policy.maxModelTokens,
          totalTokens(laneUsage(setup.events, runId, "teto")),
          { parent: runTokenBudget, scope: "teto" },
        );
        // Teto can be stopped and opened repeatedly within one activation.
        // Build a fresh compaction runtime for each scheduler instead of
        // reusing the one-shot instance, whose prepare state is one-shot.
        const createTetoCompactionRuntime = compactionEnabled
          ? () => instantiateRuntimeFukaiCompaction(
              policy,
              deps.createCompactionRuntime ?? createRuntimeFukaiCompaction,
              {
                ledger: sink,
                store,
                modelPort: tetoModel,
                model: tetoModelName,
                tokenBudget: tetoTokenBudget,
                clock,
                policy,
              },
            )
          : undefined;
        const controller = new TetoLaneController({
          eventSink: sink,
          inbox,
          store,
          model: tetoModel,
          modelName: tetoModelName,
          runId,
          goal: setup.goal,
          policy: { ...policy, tetoEnabled: true },
          workspace,
          events: setup.events,
          readEvents: () => ledger.read({ runId }),
          clock,
          tokenBudget: tetoTokenBudget,
          ...(createTetoCompactionRuntime === undefined
            ? {}
            : { createCompactionRuntime: createTetoCompactionRuntime }),
          policyVersion,
          readWatermark: () => sink.ledger.watermark(),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        scheduler = controller;
        if (policy.tetoActivation !== "manual") {
          await controller.start({
            runId,
            laneId: "main",
            workspace,
            operationId: `${runId}:teto:auto-start`,
          });
        } else {
          await controller.restoreIfRequested();
        }
      }
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
        runTokenBudget,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }

    const teamBranchModel = deps.workerModel ?? mainModel;
    const teamBranchTools = deps.workerTools ?? createWorkspaceTools({
      allowWrite: false,
      allowShell: false,
      allowImages: shouldAdvertiseImageTools(teamBranchModel, request.workerModel ?? request.model),
      protectedPaths: [resolve(request.dataDir)],
    });
    teamRuntime = new TeamRuntime({
      eventSink: sink,
      inbox,
      store,
      model: teamBranchModel,
      modelName: request.workerModel ?? request.model,
      runId,
      workspace,
      branchTools: teamBranchTools,
      runTokenBudget,
      readEvents: () => ledger.read({ runId }),
      readWatermark: () => ledger.watermark(),
      readAwareness,
      clock,
      policy,
      policyVersion,
      ...(compactionEnabled
        ? { createCompactionRuntime: deps.createCompactionRuntime ?? createRuntimeFukaiCompaction }
        : {}),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    await teamRuntime.restore();
    if (!evaluationAuxiliaryMode) {
      pushRuntimeTool(tools, createAgentAwarenessTool({ read: readAwareness }));
      if (scheduler instanceof TetoLaneController) {
        for (const tool of createTetoControlTools(scheduler)) pushRuntimeTool(tools, tool);
      }
      pushRuntimeTool(tools, createTeamTool(teamRuntime));
    } else if (useUnifiedTeto && auxiliaryMode === "teto" && adviceDelivery === "live") {
      // The unified lane still publishes Advice through the same Main-owned
      // acknowledgement tool in frozen live evaluation arms.
      pushRuntimeTool(tools, createAdviceResponseTool(inbox));
    }

    if (workerEnabled) {
      const dispatcher = new TaskDispatcher({
        inbox,
        runId,
        clock,
      });
      const workerModel = deps.workerModel ?? mainModel;
      const workerAdvertisesImages = shouldAdvertiseImageTools(
        workerModel,
        request.workerModel ?? request.model,
      );
      const workerTools = deps.workerTools ?? createWorkspaceTools({
        allowWrite: false,
        allowShell: false,
        allowImages: workerAdvertisesImages,
        protectedPaths: [resolve(request.dataDir)],
      });
      const workerExecutor = new WorkerTaskExecutor({
        inbox,
        eventSink: sink,
        store,
        model: workerModel,
        modelName: request.workerModel ?? request.model,
        runId,
        workspace,
        tools: workerTools,
        runTokenBudget,
        clock,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        readWatermark: () => sink.ledger.watermark(),
        readEvents: () => sink.ledger.read({ runId }),
      });
      workerScheduler = new WorkerLaneScheduler({
        executor: workerExecutor,
        inbox,
        runId,
        committedBoundaryMessageIds: projectCommittedBoundaryMessageIds(setup.events, runId),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      tools.push(createDelegateTaskTool({ dispatcher, store }));
    }
    const skillCapability = edgeProjection.registry === undefined
      || typeof edgeProjection.registry.loadContribution !== "function"
      ? undefined
      : createRuntimeSkillCapability({
          snapshot: edgeProjection.snapshot ?? edgeProjection.edgeSnapshot,
          registry: edgeProjection.registry as { loadContribution: NonNullable<typeof edgeProjection.registry.loadContribution> },
          workspace,
        });
    // `skill` is a host-owned capability. Remove injected/edge collisions even
    // when the captured catalog is invalid, so schema and catalog fail closed
    // as one unit.
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      if (tools[index]?.definition.name.trim() === "skill") tools.splice(index, 1);
    }
    if (skillCapability !== undefined) {
      tools.push(skillCapability.tool);
    }
    // Optional runtime capabilities are host-owned too; append edge tools only
    // after they have been admitted so an edge cannot shadow their names.
    const admittedTools = appendPermittedEdgeTools(tools, edgeProjection.edgeSnapshot, {
      allowWrite: request.allowWrite === true,
      allowShell: request.allowShell === true,
      allowNetwork: request.allowNetwork === true,
    });

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
      tools: admittedTools,
      clock,
      runTokenBudget,
      eventObserver: (event) => {
        if (event.laneId === "main" && scheduler instanceof TetoLaneController) {
          scheduler.observeMainEvent(event);
        }
      },
      ...(edgeProjection.contextContributions.length === 0
        ? {}
        : { edgeContext: edgeProjection.contextContributions }),
      ...(skillCapability === undefined
        ? {}
        : {
            skillCatalog: {
              generation: skillCapability.catalog.generation,
              entries: skillCapability.catalog.modelEntries,
            },
          }),
      ...(deps.approveTool === undefined ? {} : { approve: deps.approveTool }),
      ...(outputContinuationMessageId === undefined
        && scheduler === undefined
        && workerScheduler === undefined
        && teamRuntime === undefined
        && selectCompaction === undefined
        && compactForPressure === undefined
        ? {}
        : {
            beforeStep: async ({ step }) => {
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
                    ? scheduler.beforeMainStep({ step })
                    : Promise.resolve([])
                ),
                ...await (workerScheduler?.beforeMainStep({ step }) ?? Promise.resolve([])),
                ...await (teamRuntime?.beforeMainStep({ step }) ?? Promise.resolve([])),
              ];
            },
            ...(scheduler === undefined && workerScheduler === undefined
              && teamRuntime === undefined
              && selectCompaction === undefined
              ? {}
              : {
                  afterStep: (context) => {
                    scheduler?.enqueue(context);
                    workerScheduler?.enqueue(context);
                    teamRuntime?.enqueue(context);
                  },
                }),
            ...(selectCompaction === undefined
              ? {}
              : { selectCompaction }),
            ...(compactForPressure === undefined
              ? {}
              : { compactForPressure }),
          }),
    });

    try {
      const result = await loop.run({
        runId,
        goal: setup.goal,
        model: request.model,
        workspace: setup.workspace,
        policy: { ...policy, maxModelTokens: remainingModelTokens },
        policyVersion,
        ...(request.message === undefined && (request.images?.length ?? 0) === 0
          ? {}
          : { initialMessage: request.message ?? "" }),
        ...(request.images === undefined
          ? {}
          : { initialImages: structuredClone(request.images) }),
        startStep: setup.startStep,
        upperWatermark: mainUpperWatermark,
        conversationRefs: setup.conversationRefs,
        artifactReadRefs: setup.artifactReadRefs,
        pressureEligibleConversationCount: setup.pressureEligibleConversationCount,
        maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (scheduler !== undefined) {
        await settlesWithin(scheduler.drain(), 25);
      }
      if (workerScheduler !== undefined) {
        await settlesWithin(workerScheduler.drain(), 25);
      }
      if (teamRuntime !== undefined) {
        // Team branches are task-scoped and their terminal replies are the
        // useful output of `team_create`. Give already-admitted branches a
        // bounded grace period to publish those replies before shutting the
        // one-shot runtime down; Main remains independent of slow observers.
        await settlesWithin(teamRuntime.drain(), 500);
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
      await workerScheduler?.stop();
      await teamRuntime?.stop();
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
      await workerScheduler?.stop();
      await teamRuntime?.stop();
      if (error instanceof MainRunTokenBudgetExhaustedError) {
        const watermark = await ledger.watermark();
        await appendLaneStatus(
          sink,
          runId,
          "main",
          "waiting",
          "Run budget or Step limit exhausted",
          `main:waiting:${watermark}`,
          clock,
        );
        await commitRunCheckpoint(ledger, runId);
        const events = await ledger.read({ runId });
        const activationEvents = events.filter(
          (event) => event.globalOffset > setup.upperWatermark,
        );
        const latestCompletion = activationEvents.findLast((event): event is Extract<
          AnyEvent,
          { type: "model.completed" }
        > => event.type === "model.completed" && event.laneId === "main");
        const activation = projectMainExecutionRecovery(activationEvents);
        const metrics = projectRunMetrics(events, runId);
        return {
          runId,
          finalText: latestCompletion === undefined
            ? ""
            : await readAssistantText(store, latestCompletion.payload.responseRef),
          completed: false,
          steps: activationEvents.filter((event) => (
            event.type === "step.completed" && event.laneId === "main"
          )).length,
          usage: activation.usage,
          metrics,
          stateDir,
          blocker: "run-budget-or-step-limit",
        };
      }
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
    await workerScheduler?.stop().catch(() => undefined);
    await teamRuntime?.stop().catch(() => undefined);
    await processJobManager?.close().catch(() => undefined);
    if (closeEdgeCompositionOnClose) {
      try {
        await edgeSnapshotProvider?.close?.();
      } catch {
        // Edge shutdown is best effort after the durable Run boundary closes.
      }
    }
    await ledger.close();
  }
};

interface RunSetup {
  goal: Goal;
  policy: RunPolicy;
  workspace: string;
  startStep: number;
  upperWatermark: number;
  compactionUpperWatermark: number;
  conversationRefs: RunRecoveryState["conversationRefs"];
  artifactReadRefs: RunRecoveryState["artifactReadRefs"];
  pressureEligibleConversationCount: number;
  events: AnyEvent[];
}

const createNewRun = async (
  sink: ObservableEventSink,
  request: RunExecutionRequest,
  runId: string,
  workspace: string,
  clock: Clock,
  auxiliaryMode: AuxiliaryMode,
  workerEnabled?: boolean,
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
    ...(workerEnabled === undefined ? {} : { workerEnabled }),
    ...(request.fukaiCompaction === undefined
      ? {}
      : { fukaiCompaction: request.fukaiCompaction }),
    tetoActivation: request.tetoActivation
      ?? request.policy?.tetoActivation
      ?? (request.policy?.maxMainSteps !== undefined || request.auxiliaryMode === "teto"
        ? "automatic"
        : "manual"),
    ...(auxiliaryMode === "teto"
      ? { tetoEnabled: true }
      : auxiliaryMode === "reflection"
        ? { tetoEnabled: false }
        : request.auxiliaryMode === "none" || request.policy?.auxiliaryMode === "none"
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
    await appendLaneStatus(
      sink,
      runId,
      "teto",
      "dormant",
      policy.tetoActivation === "manual"
        ? "Teto available; Main may open it with teto_start"
        : undefined,
      "lane:teto:status:dormant",
      clock,
    );
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
  if (workerEnabled === true) {
    await sink.append({
      runId,
      laneId: "worker",
      type: "lane.registered",
      payload: { kind: "worker" },
      correlationId: `run:${runId}`,
      idempotencyKey: "lane:worker:registered",
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
    compactionUpperWatermark: await sink.ledger.watermark(),
    conversationRefs: [],
    artifactReadRefs: [],
    pressureEligibleConversationCount: 0,
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
    compactionUpperWatermark: recovered.conversationRefs.reduce(
      (highest, conversationRef) => Math.max(highest, conversationRef.sequence),
      0,
    ),
    conversationRefs: recovered.conversationRefs,
    artifactReadRefs: recovered.artifactReadRefs,
    pressureEligibleConversationCount: recovered.pressureEligibleConversationCount,
    events: await sink.ledger.read({ runId: recovered.runId }),
  };
};

class ObservableEventSink implements Ledger {
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

  read(options?: Parameters<Ledger["read"]>[0]): ReturnType<Ledger["read"]> {
    return this.ledger.read(options);
  }

  watermark(): Promise<number> {
    return this.ledger.watermark();
  }

  flush(): Promise<void> {
    return this.ledger.flush();
  }

  close(): Promise<void> {
    return this.ledger.close();
  }
}

const appendLaneStatus = async (
  sink: ObservableEventSink,
  runId: string,
  laneId: string,
  status: LaneStatus,
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
  if (request.workerModel !== undefined && request.workerModel.length === 0) {
    throw new Error("workerModel must not be empty");
  }
  if (request.workerEnabled !== undefined && typeof request.workerEnabled !== "boolean") {
    throw new Error("workerEnabled must be a boolean");
  }
  if (request.fukaiCompaction !== undefined) {
    normalizeFukaiCompactionPolicy(request.fukaiCompaction);
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

/**
 * A resumed Run keeps the policy it was created with. An omitted policy is
 * treated as the legacy disabled state so old Runs remain attachable.
 */
const validateRequestedFukaiPolicy = (
  requested: FukaiCompactionPolicy | undefined,
  recorded: FukaiCompactionPolicy | undefined,
): void => {
  if (requested === undefined || recorded === undefined) {
    if (
      requested !== undefined
      && recorded === undefined
      && normalizeFukaiCompactionPolicy(requested).enabled
    ) {
      throw new Error("Cannot enable Fukai compaction while resuming a Run without a recorded policy");
    }
    return;
  }
  const normalized = normalizeFukaiCompactionPolicy(requested);
  const normalizedRecorded = normalizeFukaiCompactionPolicy(recorded);
  if (!sameFukaiCompactionPolicy(normalized, normalizedRecorded)) {
    throw new Error("Cannot change fukaiCompaction while resuming a Run");
  }
};

const sameFukaiCompactionPolicy = (
  left: FukaiCompactionPolicy,
  right: FukaiCompactionPolicy,
): boolean => left.enabled === right.enabled
  && left.provider === right.provider
  && left.maxInputTokens === right.maxInputTokens
  && left.maxOutputTokens === right.maxOutputTokens
  && left.maxWallClockMs === right.maxWallClockMs
  && left.thresholdRatio === right.thresholdRatio
  && left.retainRatio === right.retainRatio
  && left.minimumGainTokens === right.minimumGainTokens;

function rethrowIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

const validateRunId = (runId: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Run id contains unsupported characters");
  }
};

async function canonicalWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  try {
    return await realpath(resolved);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

const laneUsage = (
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): TokenUsage => recoverRunTokenUsageByLane(events, runId)
  .find((lane) => lane.laneId === laneId)?.usage ?? emptyUsage();

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

function pushRuntimeTool(tools: AgentTool[], tool: AgentTool): void {
  const name = tool.definition.name.trim();
  if (tools.some((candidate) => candidate.definition.name.trim() === name)) {
    throw new Error(`Runtime capability collides with an existing tool: ${name}`);
  }
  tools.push(tool);
}
