import { createHash } from "node:crypto";

import type {
  AnyEvent,
  AppendEvent,
  EventPayloadMap,
  EventType,
} from "../domain/events.js";
import type { ModelRetryNotice } from "../model/retrying-model.js";
import type {
  AgentTool,
  Clock,
  ModelCapabilities,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ThinkingLevel,
  ToolResult,
} from "../domain/ports.js";
import { prepareModelPort, PreparedModelPort } from "../model/prepared-model.js";
import { withDefaultModelRetries } from "../model/retrying-model.js";
import { systemClock } from "../domain/ports.js";
import type {
  ArtifactRef,
  CacheOutcome,
  ConversationMessage,
  Goal,
  GoalContextKind,
  LaneId,
  LaneCapabilityManifest,
  NavigationDelta,
  RunId,
  RunPolicy,
  ThreadGoal,
  TokenUsage,
  ToolCall,
} from "../domain/types.js";
import { type UserImage, validateUserImages } from "../domain/images.js";
import {
  DEFAULT_MAIN_REQUEST_TIMEOUT_MS,
  DEFAULT_MAIN_OUTPUT_TOKENS,
  MAX_MAIN_REQUEST_TIMEOUT_MS,
  MAX_MAIN_OUTPUT_TOKENS,
  mainStepAllowance,
} from "../domain/types.js";
import type {
  FukaiArtifactSelection,
  FukaiBudget,
  FukaiCompactionSelection,
  FukaiConversationRef,
  FukaiEdgeContextContribution,
  FukaiLaneKind,
  FukaiSkillCatalog,
  MainContextProvider,
} from "../fukai/types.js";
import { FukaiBudgetError, fukaiSkillCatalogIdentity } from "../fukai/context-provider.js";
import { MoweExecutor } from "../mowe/index.js";
import type {
  MoweCall,
  MoweCallResult,
  MoweExecutionRequest,
} from "../mowe/types.js";
import { MAX_MOWE_MAX_OUTPUT_BYTES } from "../mowe/types.js";
import { ProviderModelError, providerUsageFromError } from "../model/provider-error.js";
import { stableJson } from "../ledger/hash.js";
import {
  boundedRedactedText,
  persistedErrorText,
  redactSensitiveText,
} from "./redaction.js";
import { renderLaneCapabilityManifest } from "./lane-context.js";
import { deriveRuntimePolicyVersion } from "./fukai-compaction-runtime.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import {
  loadProjectInstructions,
  projectInstructionManifest,
  serializeProjectInstructionBundle,
} from "./project-instructions.js";
import type {
  RunTokenBudget,
  RunTokenReservationPriority,
} from "./run-token-budget.js";
import { publicLaneName } from "./lane-names.js";
import { PROJECT_INSTRUCTIONS_MEDIA_TYPE } from "../domain/context.js";
import {
  ARTIFACT_READ_TOOL_NAME,
  artifactReadPointer,
  createArtifactReadTool,
  RunArtifactAuthorization,
  type ArtifactReadStore,
} from "../tools/artifact-read.js";

const DEFAULT_SYSTEM_PROMPT = `You are Nausicaa, a next-generation general-purpose task agent.
Handle the current user request with the runtime-provided context and tools.
The tools attached to this request are the complete tool-call interface; runtime results are authoritative.
Return a grounded result when the current request is complete.`;
const TETO_OVERVIEW = "Teto is your auxiliary observer lane: it follows your public messages and tool requests and can send advice through A2A.";

/** Conservative per-request input ceiling for custom ports without model metadata. */
export const UNKNOWN_MODEL_REQUEST_INPUT_FALLBACK_TOKENS = 32_768;
const PLAN_MODE_PROMPT = "Plan mode is active. Use the available read-only tools and return an implementation-ready plan; do not mutate files or cause external side effects.";
const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export interface MainEventSink {
  append<K extends EventType>(
    event: AppendEvent<K>,
  ): Promise<MainEventReceipt>;
}

/**
 * Ledger append receipts historically exposed only the event identity. The
 * optional event fields let newer hosts provide the committed envelope to an
 * observer without breaking those minimal sinks.
 */
export interface MainEventReceipt {
  eventId: string;
  globalOffset: number;
  runId?: string;
  laneId?: string;
  type?: EventType;
  payload?: unknown;
}

export interface MainConversationStore {
  put(data: string | Uint8Array, mediaType?: string): Promise<ArtifactRef>;
  /** Optional read capability enables the run-scoped artifact_read tool. */
  get?(ref: ArtifactRef): Promise<Uint8Array>;
}

export type MainBoundaryMessageKind =
  | "advice"
  | "question-answer"
  | "reflection"
  | "runtime-notice"
  | "steering";

export interface MainBoundaryMessage {
  kind: MainBoundaryMessageKind;
  source: string;
  content: string;
  images?: UserImage[];
  messageId: string;
  /** Optional host-owned Goal context boundary. It is dynamic and not a user Turn. */
  goalContextKind?: GoalContextKind;
  /** Fresh Goal snapshot for a host mutation delivered at this boundary. */
  goalContextGoal?: ThreadGoal;
}

export interface MainBeforeStepContext {
  runId: RunId;
  laneId: LaneId;
  step: number;
  goal: Goal;
  threadGoal?: ThreadGoal;
  previousDelta?: NavigationDelta;
  signal?: AbortSignal;
}

export interface MainNavigationContext {
  runId: RunId;
  laneId: LaneId;
  step: number;
  goal: Goal;
  threadGoal?: ThreadGoal;
  responseText: string;
  toolCalls: readonly ToolCall[];
  toolResults: readonly ConversationMessage[];
  delta: NavigationDelta;
}

export interface MainAfterStepContext extends MainNavigationContext {
  usage: TokenUsage;
  boundaryMessageIds: readonly string[];
}

export interface MainCompactionSelectionContext {
  runId: RunId;
  laneId: LaneId;
  goal: Goal;
  policyVersion: string;
  upperWatermark: number;
  signal?: AbortSignal;
}

export interface MainCompactionPressureContext extends MainCompactionSelectionContext {
  /** Model selector frozen for the provider request at this boundary. */
  model: string;
  /** Frozen, validated total model window; absent when capability metadata is unknown. */
  contextWindowTokens?: number;
  /** Input capacity after output reservation and any explicit tighter Fukai limit. */
  inputCapacityTokens: number;
  conversationRefs: readonly FukaiConversationRef[];
  estimatedInputTokens: number;
}

export interface MainLoopDeps {
  model: ModelPort;
  /** Read once at each provider boundary; an in-flight request keeps its selector. */
  resolveModel?: () => string;
  /** Captured with the model selector, never reread during an in-flight request. */
  resolveThinkingLevel?: () => ThinkingLevel | undefined;
  /** Shared admission gate for every provider call in this Run. */
  runTokenBudget?: RunTokenBudget;
  contextProvider: MainContextProvider;
  conversationStore: MainConversationStore;
  eventSink: MainEventSink;
  /** Legacy AgentTool catalog; optional when a complete Mowe executor is supplied. */
  tools?: readonly AgentTool[];
  /** Unified Mowe tool system; omitted to build one around the supplied tools. */
  mowe?: MoweExecutor;
  /** Selected edge Skill context captured for this activation. */
  edgeContext?: readonly FukaiEdgeContextContribution[];
  /** Metadata-only Skill catalog paired with the runtime skill tool. */
  skillCatalog?: FukaiSkillCatalog;
  clock?: Clock;
  /** Monotonic milliseconds used for provider/context latency metrics. */
  monotonicNow?: () => number;
  beforeStep?: (
    context: MainBeforeStepContext,
  ) => Promise<readonly MainBoundaryMessage[]>;
  navigationHook?: (
    context: MainNavigationContext,
  ) => void | NavigationDelta;
  /** Synchronously enqueue auxiliary work; never execute a model in this hook. */
  afterStep?: (context: MainAfterStepContext) => void;
  /** Optional awaited host bookkeeping at a committed step boundary. */
  afterStepAsync?: (context: MainAfterStepContext) => Promise<void>;
  /** True defers a clean completion so pending host work reaches the next step. */
  beforeCompletion?: () => Promise<boolean>;
  /** Optional, explicit selection of an already-admitted Fukai capsule. */
  selectCompaction?: (
    context: MainCompactionSelectionContext,
  ) => Promise<FukaiCompactionSelection | undefined>;
  /** DeepSeek-style pre-request pressure gate; absent means no automatic compaction. */
  compactForPressure?: (
    context: MainCompactionPressureContext,
  ) => Promise<FukaiCompactionSelection | undefined>;
  /** Host/UI approval seam for Mowe tools that declare `requiresApproval`. */
  approve?: MoweExecutionRequest["approve"];
  onStreamEvent?: (event: MainStreamEvent) => void;
  /** Lightweight event tap used by sibling lanes; never blocks the owner lane. */
  eventObserver?: (event: AnyEvent) => void;
  /** Whether this lane may load workspace project instructions. */
  includeProjectInstructions?: boolean;
}

export type MainStreamEvent = {
  runId: RunId;
  turnId?: string;
  laneId: LaneId;
  requestId: string;
  sequence: number;
} & (
  | { type: "stream.start" }
  | { type: "stream.thinking-start" }
  | { type: "stream.thinking-delta"; delta: string }
  | { type: "stream.thinking-end" }
  | { type: "stream.delta"; delta: string }
  | { type: "stream.end"; messageRef: ArtifactRef }
  | { type: "stream.cancelled"; reason: string }
  | { type: "stream.failed"; error: string }
);

type PendingMainStreamEvent = {
  input: MainLoopInput;
  laneId: LaneId;
  requestId: string;
} & (
  | { type: "stream.start" }
  | { type: "stream.thinking-start" }
  | { type: "stream.thinking-delta"; delta: string }
  | { type: "stream.thinking-end" }
  | { type: "stream.delta"; delta: string }
  | { type: "stream.end"; messageRef: ArtifactRef }
  | { type: "stream.cancelled"; reason: string }
  | { type: "stream.failed"; error: string }
);

interface MainModelStreamProgress {
  text: string;
  reasoning: string;
}

interface MainModelRetryContext {
  input: MainLoopInput;
  laneId: LaneId;
  correlationId: string;
  eventState: { watermark: number };
  eventPrefix: string;
  step: number;
  requestId: string;
}

export interface MainLoopInput {
  runId: RunId;
  /** Present for interactive Runs; omitted only for schema-v1 one-shot compatibility. */
  turnId?: string;
  /** Current Turn intent, independent from the optional thread Goal. */
  activeObjective?: string;
  /** Optional user-owned persistent thread Goal, rendered only as dynamic context. */
  threadGoal?: ThreadGoal;
  /** Initial one-shot Goal context boundary; consumed after the first request. */
  goalContextKind?: GoalContextKind;
  goal: Goal;
  model: string;
  workspace: string;
  policy: RunPolicy;
  initialMessage?: string;
  initialImages?: UserImage[];
  /** Origin metadata for a lane-projected input; omitted for ordinary Main input. */
  initialMessageSourceEventId?: string;
  initialMessageSourceLane?: LaneId;
  laneId?: LaneId;
  sessionId?: string;
  systemPrompt?: string;
  /** Fukai lane role; defaults to Main for legacy callers. */
  laneKind?: FukaiLaneKind;
  /** Host-provided public manifests for lanes Main may reach. */
  laneCapabilityManifests?: readonly LaneCapabilityManifest[];
  /** Override the loop default for workspace instruction visibility. */
  includeProjectInstructions?: boolean;
  /** Collaboration behavior selected by the interactive surface for this activation. */
  collaborationMode?: "default" | "plan";
  policyVersion?: string;
  upperWatermark?: number;
  startStep?: number;
  maxOutputTokens?: number;
  contextBudget?: Partial<FukaiBudget>;
  conversationRefs?: readonly FukaiConversationRef[];
  /** Strict incoming prefix already included in a successful Main request. */
  pressureEligibleConversationCount?: number;
  /** Complete Mowe result refs recovered from prior Main tool terminal events. */
  artifactReadRefs?: readonly ArtifactRef[];
  /** Admission priority relative to the owning Run budget. */
  reservationPriority?: RunTokenReservationPriority;
  artifactSelections?: readonly FukaiArtifactSelection[];
  correlationId?: string;
  /** Legacy one-shot completes the Run; interactive execution completes only its Turn. */
  completeRun?: boolean;
  signal?: AbortSignal;
  /** Suppress Run/Turn completion facts for long-lived auxiliary lanes. */
  completionMode?: "run" | "turn" | "none";
}

export interface MainLoopResult {
  finalText: string;
  steps: number;
  usage: TokenUsage;
  completed: boolean;
  /** Provider stop reason for the last committed assistant message. */
  stopReason?: string;
  conversationRefs: FukaiConversationRef[];
  navigationDeltas: NavigationDelta[];
  finalMessageRef?: ArtifactRef;
}

export class MainRunTokenBudgetExhaustedError extends Error {
  override readonly name = "MainRunTokenBudgetExhaustedError";
  readonly code = "run-budget-exhausted";
}

// Tool schemas and serialized runtime metadata make input estimates slightly
// conservative. Keep a bounded allowance for that variance while retaining a
// fail-closed boundary for materially over-budget requests.
const MAIN_ADMISSION_SLACK_TOKENS = 1_024;
const MAIN_ADMISSION_SLACK_MIN_CAPACITY = 256;

export class MainLoop {
  private readonly model: PreparedModelPort;
  private readonly resolveModel: MainLoopDeps["resolveModel"];
  private readonly resolveThinkingLevel: MainLoopDeps["resolveThinkingLevel"];
  private readonly runTokenBudget: RunTokenBudget | undefined;
  private readonly contextProvider: MainContextProvider;
  private readonly conversationStore: MainConversationStore;
  private readonly eventSink: MainEventSink;
  private readonly mowe: MoweExecutor;
  private readonly clock: Clock;
  private readonly monotonicNow: () => number;
  private readonly beforeStep: MainLoopDeps["beforeStep"];
  private readonly navigationHook: MainLoopDeps["navigationHook"];
  private readonly afterStep: MainLoopDeps["afterStep"];
  private readonly afterStepAsync: MainLoopDeps["afterStepAsync"];
  private readonly beforeCompletion: MainLoopDeps["beforeCompletion"];
  private readonly selectCompaction: MainLoopDeps["selectCompaction"];
  private readonly compactForPressure: MainLoopDeps["compactForPressure"];
  private readonly approve: MainLoopDeps["approve"];
  private readonly onStreamEvent: MainLoopDeps["onStreamEvent"];
  private readonly eventObserver: MainLoopDeps["eventObserver"];
  private readonly includeProjectInstructions: boolean;
  private readonly edgeContext: readonly FukaiEdgeContextContribution[];
  private readonly skillCatalog: FukaiSkillCatalog | undefined;
  private readonly artifactAuthorization: RunArtifactAuthorization | undefined;
  private readonly streamSequences = new Map<string, number>();
  private readonly modelCallAttempts = new Map<string, number>();
  private readonly modelRetryContexts = new Map<string, MainModelRetryContext>();

  constructor(deps: MainLoopDeps) {
    // Every Main/Teto/Team request passes through one immutable provider
    // boundary.  The wrapper is local to this loop so provider-owned catalogs
    // remain free to change between requests while an in-flight request stays
    // pinned to its captured data and method bindings.
    // Keep retries at the provider boundary and request snapshots outside it.
    // A caller-supplied prepared port already owns that boundary; wrapping it
    // again would re-probe capabilities and snapshot the same request twice.
    this.model = deps.model instanceof PreparedModelPort
      ? deps.model
      : prepareModelPort(withDefaultModelRetries(deps.model, {
          onRetry: (notice) => this.persistModelRetry(notice),
        }));
    this.resolveModel = deps.resolveModel;
    this.resolveThinkingLevel = deps.resolveThinkingLevel;
    this.runTokenBudget = deps.runTokenBudget;
    this.contextProvider = deps.contextProvider;
    this.conversationStore = deps.conversationStore;
    this.eventSink = deps.eventSink;
    const callerHasArtifactReader = (deps.tools ?? []).some((tool) => (
      tool.definition.name.trim() === ARTIFACT_READ_TOOL_NAME
    ));
    this.artifactAuthorization = deps.mowe === undefined
      && !callerHasArtifactReader
      && typeof deps.conversationStore.get === "function"
      ? new RunArtifactAuthorization()
      : undefined;
    const defaultTools = deps.mowe === undefined
      ? withArtifactReadTool(
          deps.tools ?? [],
          deps.conversationStore,
          this.artifactAuthorization,
        )
      : [];
    this.mowe = deps.mowe ?? new MoweExecutor({
      catalog: defaultTools,
      maxConcurrency: 4,
      // Mowe may persist/project the complete sanitized result. The Main
      // context boundary applies its own smaller inline budget below.
      sanitizeResult: (result) => ({
        content: redactSensitiveText(result.content),
        isError: result.isError,
        ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
      }),
    });
    this.clock = deps.clock ?? systemClock;
    this.monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;
    this.beforeStep = deps.beforeStep;
    this.navigationHook = deps.navigationHook;
    this.afterStep = deps.afterStep;
    this.afterStepAsync = deps.afterStepAsync;
    this.beforeCompletion = deps.beforeCompletion;
    this.selectCompaction = deps.selectCompaction;
    this.compactForPressure = deps.compactForPressure;
    this.approve = deps.approve;
    this.onStreamEvent = deps.onStreamEvent;
    this.eventObserver = deps.eventObserver;
    this.includeProjectInstructions = deps.includeProjectInstructions ?? true;
    this.edgeContext = deps.edgeContext === undefined
      ? []
      : Object.freeze(deps.edgeContext.map((item) => structuredClone(item)));
    if (deps.skillCatalog === undefined) {
      this.skillCatalog = undefined;
    } else {
      const skillCatalog = structuredClone(deps.skillCatalog);
      this.skillCatalog = Object.freeze({
        generation: skillCatalog.generation,
        entries: Object.freeze(skillCatalog.entries.map((entry) => Object.freeze({ ...entry }))),
      });
    }
  }

  async run(input: MainLoopInput): Promise<MainLoopResult> {
    validateInput(input);
    throwIfAborted(input.signal);

    const laneId = input.laneId ?? "main";
    const sessionId = input.sessionId ?? `${input.runId}:${laneId}`;
    const eventPrefix = input.turnId === undefined
      ? laneId
      : `${input.runId}:turn:${input.turnId}`;
    const correlationId = input.correlationId ?? `corr:${hashStable({
      runId: input.runId,
      turnId: input.turnId,
      laneId,
      loop: "main",
    })}`;
    const startStep = input.startStep ?? 1;
    const policyVersion = input.policyVersion ?? deriveRuntimePolicyVersion(input.policy);
    const mainRequestTimeoutMs = input.policy.mainRequestTimeoutMs
      ?? DEFAULT_MAIN_REQUEST_TIMEOUT_MS;
    const allowance = mainStepAllowance(input.policy);
    const finalStep = "maxMainStepsPerActivation" in input.policy
      ? startStep + allowance - 1
      : allowance;
    const eventState = { watermark: input.upperWatermark ?? 0 };
    const conversationRefs = [...(input.conversationRefs ?? [])]
      .map((ref) => structuredClone(ref));
    // Only refs included in an earlier Main request may be summarized. New
    // user/boundary input and unseen tool results remain raw for their first read.
    let pressureEligibleConversationCount = input.pressureEligibleConversationCount ?? 0;
    const artifactSelections = [...(input.artifactSelections ?? [])]
      .map((selection) => structuredClone(selection));
    let sequence = conversationRefs.reduce(
      (highest, ref) => Math.max(highest, ref.sequence),
      0,
    );
    let usage = emptyUsage();
    let finalText = "";
    let lastStopReason: string | undefined;
    let finalMessageRef: ArtifactRef | undefined;
    let previousDelta: NavigationDelta | undefined;
    let steps = 0;
    const navigationDeltas: NavigationDelta[] = [];
    let pendingGoalContextKind = input.goalContextKind;

    this.artifactAuthorization?.beginRun(input.runId, input.artifactReadRefs ?? []);

    if (input.initialMessage !== undefined || (input.initialImages?.length ?? 0) > 0) {
      const initialMessage: ConversationMessage = {
        role: "user",
        content: input.initialMessage ?? "",
        ...(input.initialImages === undefined
          ? {}
          : { images: structuredClone(input.initialImages) }),
        ...(input.initialMessageSourceEventId === undefined
          ? {}
          : { sourceEventId: input.initialMessageSourceEventId }),
        ...(input.initialMessageSourceLane === undefined
          ? {}
          : { sourceLane: input.initialMessageSourceLane }),
        createdAt: this.clock.now().toISOString(),
      };
      const initialRef = await this.writeMessage(initialMessage);
      sequence += 1;
      conversationRefs.push({
        ref: initialRef,
        sequence,
        groupId: input.turnId === undefined
          ? `${input.runId}:input:${startStep}`
          : `${input.runId}:turn:${input.turnId}:input`,
      });
      await this.emit(input, laneId, correlationId, eventState, {
        type: "user.message",
        payload: {
          messageRef: initialRef,
          ...(input.initialMessageSourceEventId === undefined
            ? {}
            : { sourceEventId: input.initialMessageSourceEventId }),
          ...(input.initialMessageSourceLane === undefined
            ? {}
            : { sourceLane: input.initialMessageSourceLane }),
        },
        idempotencyKey: `${eventPrefix}:input:${startStep}`,
      });
    }

    for (let step = startStep; step <= finalStep; step += 1) {
      throwIfAborted(input.signal);
      if (
        input.policy.maxModelTokens !== undefined
        && chargedTokens(usage) >= input.policy.maxModelTokens
      ) {
        break;
      }
      steps += 1;

      const stepWatermark = await this.emit(input, laneId, correlationId, eventState, {
        type: "step.started",
        payload: { step },
        idempotencyKey: `${eventPrefix}:step:${step}:started`,
      });

      try {
        const boundaryMessages = await this.readBoundaryMessages({
          runId: input.runId,
          laneId,
          step,
          goal: input.goal,
          ...(input.threadGoal === undefined
            ? {}
            : { threadGoal: input.threadGoal }),
          ...(previousDelta === undefined ? {} : { previousDelta }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        // A host Goal mutation may arrive at the same safe boundary as other
        // advisory messages. It takes precedence over the activation's initial
        // continuation context and supplies the freshest Goal snapshot.
        const goalBoundary = boundaryMessages.find((message) => (
          message.goalContextKind !== undefined
        ));
        const goalContextKind = goalBoundary?.goalContextKind ?? pendingGoalContextKind;
        const goalContextGoal = goalBoundary?.goalContextGoal ?? input.threadGoal;
        const boundaryRefs: { messageId: string; messageRef: ArtifactRef }[] = [];
        for (const boundary of boundaryMessages) {
          // Goal context is rendered by Fukai as an ephemeral, typed dynamic
          // block. Do not persist it as an ordinary user message or expose it
          // to the next normal Turn.
          if (boundary.goalContextKind !== undefined) continue;
          const message = boundaryConversationMessage(boundary, this.clock.now());
          const ref = await this.writeMessage(message);
          boundaryRefs.push({ messageId: boundary.messageId, messageRef: ref });
          sequence += 1;
          conversationRefs.push({
            ref,
            sequence,
            groupId: `${input.runId}:boundary:${boundary.messageId}`,
          });
        }
        const requestConversationCount = conversationRefs.length;

        const contextStartedAt = this.monotonicNow();
        // A concurrent selector change applies either to this complete request
        // boundary or the next one, never halfway through context assembly.
        const requestModel = this.resolveModel?.() ?? input.model;
        const thinkingLevel = this.resolveThinkingLevel?.();
        const modelCapabilities = resolveModelCapabilities(this.model, requestModel);
        const imageInputCapability = modelCapabilities?.imageInput;
        const imageInputSupported = imageInputCapability !== false;
        const resolvedContext = resolveContextBudget(
          input,
          modelCapabilities?.contextWindowTokens,
          input.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS,
        );
        const contextBudget = resolvedContext.budget;
        const availableRequestTools = this.mowe.catalog.definitions().filter((definition) => (
          (imageInputSupported || definition.name !== "read_image")
          && (
            input.collaborationMode !== "plan"
            || definition.metadata.effect === "read"
            || definition.metadata.effect === "compute"
          )
        )).map(({ metadata: _metadata, ...definition }) => definition);
        const artifactReadAvailable = this.artifactAuthorization === undefined
          || this.artifactAuthorization.hasAny(input.runId);
        // The runtime-owned Skill capability is atomic: a schema is eligible
        // only when this activation captured a matching non-empty catalog.
        let requestTools = availableRequestTools.filter((definition) => (
          definition.name !== ARTIFACT_READ_TOOL_NAME || artifactReadAvailable
        )).filter((definition) => (
          definition.name !== "skill" || this.skillCatalog !== undefined
        ));
        let requestToolNames = new Set(requestTools.map((definition) => definition.name));
        const projectInstructions = (input.includeProjectInstructions
          ?? this.includeProjectInstructions)
          ? await loadProjectInstructions(input.workspace)
          : undefined;
        throwIfAborted(input.signal);
        const projectInstructionBundleRef = projectInstructions === undefined
          || projectInstructions.files.length === 0
          ? undefined
          : await this.conversationStore.put(
              serializeProjectInstructionBundle(projectInstructions),
              PROJECT_INSTRUCTIONS_MEDIA_TYPE,
            );
        const projectInstructionsManifest = projectInstructions === undefined
          ? undefined
          : projectInstructionManifest(projectInstructions, projectInstructionBundleRef);
        let compaction: FukaiCompactionSelection | undefined;
        if (this.selectCompaction !== undefined) {
          try {
            compaction = await this.selectCompaction({
              runId: input.runId,
              laneId,
              goal: input.goal,
              policyVersion,
              upperWatermark: stepWatermark.globalOffset,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
          } catch {
            throwIfAborted(input.signal);
            compaction = undefined;
          }
        }
        const contextRequestFor = (
          tools: readonly AgentTool["definition"][],
          includeSkillCatalog = true,
        ) => ({
          runId: input.runId,
          laneId,
          laneKind: input.laneKind ?? "main",
          goal: input.goal,
          ...(goalContextKind === undefined || goalContextGoal === undefined
            ? {}
            : {
                threadGoal: goalContextGoal,
                goalContextKind,
              }),
          workspace: input.workspace,
          ...(input.activeObjective === undefined
            ? {}
            : { activeObjective: input.activeObjective }),
          systemPrompt: effectiveSystemPrompt({
            ...input,
            tetoControlsAvailable: tools.some((tool) => tool.name === "teto_stop")
              && tools.some((tool) => tool.name === "teto_start"),
          }),
          projectInstructions: projectInstructions?.files ?? [],
          ...(projectInstructionsManifest === undefined
            ? {}
            : { projectInstructionManifest: projectInstructionsManifest }),
          ...(this.edgeContext.length === 0 ? {} : { edgeContext: this.edgeContext }),
          ...(this.edgeContext.length === 0 ? {} : { skillContext: this.edgeContext }),
          ...(includeSkillCatalog && this.skillCatalog !== undefined
            ? { skillCatalog: this.skillCatalog }
            : {}),
          conversationRefs,
          artifactSelections,
          tools,
          upperWatermark: stepWatermark.globalOffset,
          policyVersion,
          budget: contextBudget,
          ...(imageInputCapability === undefined
            ? {}
            : { imageInputSupported: imageInputCapability }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        let includeSkillCatalog = this.skillCatalog !== undefined
          && requestTools.some((definition) => definition.name === "skill");
        let contextRequest = contextRequestFor(requestTools, includeSkillCatalog);
        const buildContext = async (): Promise<Awaited<ReturnType<MainContextProvider["build"]>>> => {
          try {
            return await this.contextProvider.build({
              ...contextRequest,
              ...(compaction === undefined ? {} : { compaction }),
            });
          } catch (error: unknown) {
            if (!(error instanceof FukaiBudgetError) || compaction === undefined) throw error;
            throwIfAborted(input.signal);
            compaction = undefined;
            return this.contextProvider.build(contextRequest);
          }
        };
        let view: Awaited<ReturnType<MainContextProvider["build"]>>;
        try {
          view = await buildContext();
        } catch (error: unknown) {
          if (!(error instanceof FukaiBudgetError)
            || !includeSkillCatalog
            || this.skillCatalog === undefined) {
            throw error;
          }
          // A catalog is optional dynamic context. If retaining it leaves no
          // room for required selected context, retry this boundary with the
          // paired schema and catalog removed together.
          requestTools = requestTools.filter((definition) => definition.name !== "skill");
          requestToolNames = new Set(requestTools.map((definition) => definition.name));
          includeSkillCatalog = false;
          contextRequest = contextRequestFor(requestTools, false);
          view = await buildContext();
        }
        // Fukai may omit the catalog when the dynamic context cannot fit its
        // budget. In that case hide the paired schema in the same provider
        // request instead of exposing an unusable runtime capability.
        if (
          includeSkillCatalog
          && this.skillCatalog !== undefined
          && !hasRenderedSkillCatalog(view, this.skillCatalog)
        ) {
          requestTools = requestTools.filter((definition) => definition.name !== "skill");
          requestToolNames = new Set(requestTools.map((definition) => definition.name));
          includeSkillCatalog = false;
          contextRequest = contextRequestFor(requestTools, false);
          view = await buildContext();
        }
        // The initial context boundary is one-shot. A later step may still
        // receive a fresh host boundary (for example budget-limit steering).
        pendingGoalContextKind = undefined;
        const remainingTokens = input.policy.maxModelTokens === undefined
          ? undefined
          : Math.max(
              1,
              input.policy.maxModelTokens - chargedTokens(usage),
            );
        let maxOutputTokens = Math.min(
          input.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS,
          remainingTokens ?? Number.MAX_SAFE_INTEGER,
        );
        const reservationId = this.nextModelReservationId(input, laneId, step);
        let reservedMainTokens: number | undefined;
        if (this.runTokenBudget !== undefined) {
          // Main owns the Run's forward progress. Advisory reservations (Teto,
          // reflection) may be in flight after this context was built; they
          // must not turn a valid Main request into a false budget stop.
          const reservationPriority = input.reservationPriority ?? "main";
          const baseAvailableOutputTokens = this.runTokenBudget.availableTokens({ priority: reservationPriority })
            - view.usage.estimatedInputTokens;
          const admissionSlack = reservationPriority === "main"
            && this.runTokenBudget.availableTokens({ priority: reservationPriority }) >= MAIN_ADMISSION_SLACK_MIN_CAPACITY
            && baseAvailableOutputTokens < 0
            ? MAIN_ADMISSION_SLACK_TOKENS
            : 0;
          const availableOutputTokens = baseAvailableOutputTokens + admissionSlack;
          if (availableOutputTokens < 1) {
            throw new MainRunTokenBudgetExhaustedError(
              `Run model token budget exhausted before Main step ${step}`,
            );
          }
          maxOutputTokens = Math.min(maxOutputTokens, availableOutputTokens);
          const reservedTokens = view.usage.estimatedInputTokens + maxOutputTokens;
          if (this.runTokenBudget.reserve(reservationId, reservedTokens, {
            priority: reservationPriority,
            maxOverdraftTokens: admissionSlack,
          }) === undefined) {
            throw new MainRunTokenBudgetExhaustedError(
              `Run model token budget exhausted before Main step ${step}`,
            );
          }
          reservedMainTokens = reservedTokens;
        }
        if (this.compactForPressure !== undefined) {
          try {
            const pressured = await this.compactForPressure({
              runId: input.runId,
              laneId,
              goal: input.goal,
              policyVersion,
              upperWatermark: stepWatermark.globalOffset,
              model: requestModel,
              ...(resolvedContext.contextWindowTokens === undefined
                ? {}
                : { contextWindowTokens: resolvedContext.contextWindowTokens }),
              inputCapacityTokens: contextBudget.maxInputTokens,
              conversationRefs: conversationRefs.slice(
                0,
                pressureEligibleConversationCount,
              ),
              estimatedInputTokens: view.usage.estimatedInputTokens,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            if (
              pressured !== undefined
              && pressured.capsule.compactionId !== compaction?.capsule.compactionId
            ) {
              const candidateView = await this.contextProvider.build({
                ...contextRequest,
                compaction: pressured,
              });
              const candidateOutputHeadroom = reservedMainTokens === undefined
                ? undefined
                : reservedMainTokens - candidateView.usage.estimatedInputTokens;
              if (
                candidateOutputHeadroom === undefined
                || candidateOutputHeadroom >= 1
              ) {
                view = candidateView;
                compaction = pressured;
                if (candidateOutputHeadroom !== undefined) {
                  maxOutputTokens = Math.min(
                    maxOutputTokens,
                    candidateOutputHeadroom,
                  );
                }
              }
            }
          } catch {
            if (input.signal?.aborted === true) {
              this.runTokenBudget?.cancel(reservationId);
            }
            throwIfAborted(input.signal);
            // Optional compaction never displaces the bounded raw/current view.
          }
        }
        const contextBuildMs = elapsedMilliseconds(contextStartedAt, this.monotonicNow());
        const requestHash = hashStable({
          context: view.cacheKey,
          model: requestModel,
          maxOutputTokens,
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          sessionId,
        });
        let requestEvent: { eventId: string; globalOffset: number } | undefined;
        let response: ModelResponse;
        let providerDispatched = false;
        const streamProgress: MainModelStreamProgress = { text: "", reasoning: "" };
        let requestDeadlineSignal: AbortSignal | undefined;
        // Start the wall-clock budget at the provider request boundary, before
        // persisting model.requested.  The event and ModelRequest therefore
        // describe the same deadline even when the Ledger append is slow.
        const deadline = createMainRequestDeadline(
          input.signal,
          mainRequestTimeoutMs,
          this.clock.now(),
        );
        requestDeadlineSignal = deadline.signal;
        const deadlineAt = deadline.deadlineAt;
        const modelStartedAt = this.monotonicNow();
        try {
          requestEvent = await this.emit(input, laneId, correlationId, eventState, {
            type: "model.requested",
            payload: {
              model: requestModel,
              requestHash,
              ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
              contextWatermark: view.upperWatermark,
              deadlineMs: mainRequestTimeoutMs,
              deadlineAt,
              sessionId,
              prefixHash: view.prefixHash,
              dependencyRefs: [...view.dependencyRefs],
              truncations: structuredClone(view.truncations),
              contextBuildMs,
              estimatedInputTokens: view.usage.estimatedInputTokens,
              contextManifest: structuredClone(view.manifest),
            },
            idempotencyKey: `${eventPrefix}:step:${step}:model:requested`,
          });
          const modelRequest: ModelRequest = {
            runId: input.runId,
            laneId,
            requestId: requestEvent.eventId,
            sessionId,
            model: requestModel,
            systemPrompt: view.systemPrompt,
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            messages: view.messages,
            tools: requestTools,
            maxOutputTokens,
          };
          // The runtime-owned signal is authoritative for every provider
          // request. It combines caller cancellation with the bounded Main
          // deadline, so a provider cannot outlive either boundary merely
          // because this activation is a one-shot invocation.
          const providerSignal = deadline.signal;
          this.modelRetryContexts.set(requestEvent.eventId, {
            input,
            laneId,
            correlationId,
            eventState,
            eventPrefix,
            step,
            requestId: requestEvent.eventId,
          });
          response = await this.requestModel(
            {
              ...modelRequest,
              deadlineMs: mainRequestTimeoutMs,
              deadlineAt,
              signal: providerSignal,
            },
            input,
            laneId,
            requestEvent.eventId,
            streamProgress,
            deadline.signal,
            modelCapabilities,
            () => { providerDispatched = true; },
          );
          // A provider promise and the runtime timer can settle in the same
          // turn of the event loop. Once the deadline has fired, the response
          // is no longer admissible even if the promise won the race.
          if (deadline.signal.aborted) {
            throw abortReason(deadline.signal);
          }
        } catch (error: unknown) {
          if (requestEvent === undefined) {
            this.runTokenBudget?.cancel(reservationId);
            throw error;
          }
          const timedOut = input.signal?.aborted !== true
            && isMainRequestTimeout(requestDeadlineSignal);
          const terminalError = timedOut
            ? mainRequestTimeoutError()
            : error;
          const failureUsage = providerUsageFromError(terminalError);
          if (failureUsage === undefined) {
            this.runTokenBudget?.cancel(reservationId);
          } else {
            try {
              await this.emit(input, laneId, correlationId, eventState, {
                type: "budget.charged",
                payload: { laneId, usage: failureUsage },
                idempotencyKey: `${eventPrefix}:step:${step}:budget`,
                causationId: requestEvent.eventId,
              });
              this.runTokenBudget?.settle(reservationId, failureUsage);
            } catch (budgetError: unknown) {
              this.runTokenBudget?.settle(reservationId, failureUsage);
              throw budgetError;
            }
          }
          const cancelled = input.signal?.aborted === true;
          const interruptionReason = cancelled
            ? "cancelled" as const
            : terminalError instanceof ProviderModelError && terminalError.category === "timeout"
              ? "timeout" as const
              : "error" as const;
          if (interruptionReason !== "error") {
            await this.persistInterruptedStream(
              input,
              laneId,
              correlationId,
              eventState,
              eventPrefix,
              step,
              requestEvent.eventId,
              streamProgress,
              interruptionReason,
            );
          }
          if (cancelled) {
            const reason = persistedErrorText(input.signal?.reason, "Cancelled");
            await this.emit(input, laneId, correlationId, eventState, {
              type: "model.cancelled",
              payload: { requestId: requestEvent.eventId, reason, dispatched: providerDispatched },
              idempotencyKey: `${eventPrefix}:step:${step}:model:cancelled`,
              causationId: requestEvent.eventId,
            });
            this.publishStream({
              type: "stream.cancelled",
              input,
              laneId,
              requestId: requestEvent.eventId,
              reason,
            });
          } else {
            const message = persistedErrorText(terminalError);
            const retryable = providerRetryability(terminalError);
            await this.emit(input, laneId, correlationId, eventState, {
              type: "model.failed",
              payload: {
                model: requestModel,
                error: message,
                ...(retryable === undefined ? {} : { retryable }),
              },
              idempotencyKey: `${eventPrefix}:step:${step}:model:failed`,
              causationId: requestEvent.eventId,
            });
            this.publishStream({
              type: "stream.failed",
              input,
              laneId,
              requestId: requestEvent.eventId,
              error: message,
            });
          }
          throw terminalError;
        } finally {
          deadline.dispose();
          if (requestEvent !== undefined) {
            this.modelRetryContexts.delete(requestEvent.eventId);
          }
        }
        try {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "budget.charged",
            payload: { laneId, usage: response.usage },
            idempotencyKey: `${eventPrefix}:step:${step}:budget`,
          });
        } catch (error: unknown) {
          // A failed charge append did not establish durable accounting. Drop
          // the admission reservation so a later retry in this Session is not
          // blocked by capacity that is no longer owned by an in-flight call.
          this.runTokenBudget?.cancel(reservationId);
          throw error;
        }
        // Persist the charge before mutating the in-memory gate. Ledger
        // recovery is the authority if this activation fails immediately
        // after the provider returns.
        this.runTokenBudget?.settle(reservationId, response.usage);
        const modelLatencyMs = elapsedMilliseconds(modelStartedAt, this.monotonicNow());

        usage = addUsage(usage, response.usage);
        finalText = response.content;
        lastStopReason = response.stopReason;
        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content: response.content,
          toolCalls: structuredClone(response.toolCalls),
          createdAt: this.clock.now().toISOString(),
        };
        const assistantRef = await this.writeMessage(assistantMessage);
        finalMessageRef = assistantRef;
        sequence += 1;
        conversationRefs.push({
          ref: assistantRef,
          sequence,
          groupId: input.turnId === undefined
            ? `${input.runId}:step:${step}`
            : `${input.runId}:turn:${input.turnId}:step:${step}`,
        });

        validateToolCalls(response.toolCalls);
        await this.emit(input, laneId, correlationId, eventState, {
          type: "model.completed",
          payload: {
            model: requestModel,
            responseRef: assistantRef,
            stopReason: response.stopReason,
            usage: response.usage,
            modelLatencyMs,
            cacheOutcome: cacheOutcome(response.usage),
          },
          idempotencyKey: `${eventPrefix}:step:${step}:model:completed`,
          causationId: requestEvent.eventId,
        });
        await this.emit(input, laneId, correlationId, eventState, {
          type: "assistant.message",
          payload: { messageRef: assistantRef },
          idempotencyKey: `${eventPrefix}:step:${step}:assistant`,
          causationId: requestEvent.eventId,
        });
        pressureEligibleConversationCount = requestConversationCount;
        this.publishStream({
          type: "stream.end",
          input,
          laneId,
          requestId: requestEvent.eventId,
          messageRef: assistantRef,
        });
        const blockedToolCallError = response.stopReason === "aborted"
          ? "Tool call was not executed because the provider aborted this response."
          : response.stopReason === "length"
          ? "Tool call was not executed because the model response hit its output token limit; its arguments may be truncated. Re-issue the complete tool call."
          : undefined;
        const toolMessages = response.toolCalls.length === 0
          ? []
          : await this.executeTools(
              input,
              laneId,
              correlationId,
              eventState,
              eventPrefix,
              step,
              response.toolCalls,
              requestToolNames,
              blockedToolCallError,
            );
        for (const toolMessage of toolMessages) {
          sequence += 1;
          conversationRefs.push({
            ref: toolMessage.ref,
            sequence,
            groupId: input.turnId === undefined
              ? `${input.runId}:step:${step}`
              : `${input.runId}:turn:${input.turnId}:step:${step}`,
          });
        }

        const defaultDelta = defaultNavigationDelta(
          input,
          laneId,
          step,
          response.content,
          response.toolCalls,
          toolMessages.map((result) => result.message),
          response.stopReason,
          previousDelta,
        );
        // Navigation hooks may only derive/dispatch local state. Auxiliary
        // model work belongs behind afterStep and must not block Main.
        const hookDelta = this.navigationHook?.({
          runId: input.runId,
          laneId,
          step,
          goal: input.goal,
          ...(input.threadGoal === undefined
            ? {}
            : { threadGoal: input.threadGoal }),
          responseText: response.content,
          toolCalls: response.toolCalls,
          toolResults: toolMessages.map((result) => result.message),
          delta: structuredClone(defaultDelta),
        });
        const delta = hookDelta ?? defaultDelta;
        previousDelta = delta;
        navigationDeltas.push(delta);
        const boundaryMessageIds = boundaryMessages.map((message) => message.messageId);
        await this.emit(input, laneId, correlationId, eventState, {
          type: "navigation.updated",
          payload: { delta },
          idempotencyKey: `${eventPrefix}:step:${step}:navigation`,
        });
        await this.emit(input, laneId, correlationId, eventState, {
          type: "step.completed",
          payload: {
            step,
            hasToolCalls: response.toolCalls.length > 0,
            boundaryMessageIds,
            ...(boundaryRefs.length === 0 ? {} : { boundaryMessages: boundaryRefs }),
          },
          idempotencyKey: `${eventPrefix}:step:${step}:completed`,
        });

        await this.dispatchAfterStep({
          runId: input.runId,
          laneId,
          step,
          goal: input.goal,
          responseText: response.content,
          toolCalls: response.toolCalls,
          toolResults: toolMessages.map((result) => result.message),
          delta,
          usage: response.usage,
          boundaryMessageIds,
        });

        // Persist rejected tool results for resume, then end this activation.
        if (response.stopReason === "aborted") break;

        if (response.toolCalls.length === 0 && response.stopReason === "stop") {
          const deferCompletion = await this.beforeCompletion?.();
          // No further await precedes completion admission. Once append begins,
          // its durable outcome wins over cancellation arriving during commit.
          throwIfAborted(input.signal);
          if (deferCompletion) continue;
          const completionMode = input.completionMode
            ?? (input.turnId !== undefined && input.completeRun !== true ? "turn" : "run");
          if (completionMode === "none") {
            return {
              finalText,
              steps,
              usage,
              completed: true,
              stopReason: response.stopReason,
              conversationRefs,
              navigationDeltas,
              finalMessageRef,
            };
          }
          if (completionMode === "turn" && input.turnId !== undefined) {
            await this.emit(input, laneId, correlationId, eventState, {
              type: "turn.completed",
              payload: { turnId: input.turnId, answerRef: assistantRef },
              idempotencyKey: `${eventPrefix}:completed`,
              causationId: requestEvent.eventId,
            });
          } else {
            await this.emit(input, laneId, correlationId, eventState, {
              type: "run.completed",
              payload: { answerRef: assistantRef },
              idempotencyKey: `${eventPrefix}:run:completed`,
            });
          }
          return {
            finalText,
            steps,
            usage,
            completed: true,
            stopReason: response.stopReason,
            conversationRefs,
            navigationDeltas,
            finalMessageRef,
          };
        }
        if (response.toolCalls.length === 0) {
          return {
            finalText,
            steps,
            usage,
            completed: false,
            stopReason: response.stopReason,
            conversationRefs,
            navigationDeltas,
            finalMessageRef,
          };
        }
      } catch (error: unknown) {
        if (input.signal?.aborted !== true) {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "step.failed",
            payload: { step, error: persistedErrorText(error) },
            idempotencyKey: `${eventPrefix}:step:${step}:failed`,
          });
        }
        throw error;
      }
    }

    return {
      finalText,
      steps,
      usage,
      completed: false,
      ...(lastStopReason === undefined ? {} : { stopReason: lastStopReason }),
      conversationRefs,
      navigationDeltas,
      ...(finalMessageRef === undefined ? {} : { finalMessageRef }),
    };
  }

  private async readBoundaryMessages(
    context: MainBeforeStepContext,
  ): Promise<readonly MainBoundaryMessage[]> {
    const messages = await this.beforeStep?.(context) ?? [];
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.messageId.length === 0 || message.source.length === 0) {
        throw new Error("Boundary messages require messageId and source");
      }
      if (ids.has(message.messageId)) {
        throw new Error(`Duplicate boundary message: ${message.messageId}`);
      }
      ids.add(message.messageId);
    }
    return messages;
  }

  /**
   * Mowe owns the unified one-or-many operation boundary. Main keeps the
   * existing Ledger event shape and conversation refs around that boundary.
   */
  private async executeTools(
    input: MainLoopInput,
    laneId: LaneId,
    correlationId: string,
    eventState: { watermark: number },
    eventPrefix: string,
    step: number,
    calls: readonly ToolCall[],
    requestToolNames: ReadonlySet<string>,
    forcedError?: string,
  ): Promise<{ message: ConversationMessage; ref: ArtifactRef }[]> {
    throwIfAborted(input.signal);
    const preparedCalls: MoweCall[] = [];
    for (const call of calls) {
      const operationId = `op:${hashStable({
        runId: input.runId,
        turnId: input.turnId,
        laneId,
        step,
        toolCallId: call.id,
        toolName: call.name,
      })}`;
      const argumentsRef = await this.conversationStore.put(
        stableJson(call.arguments),
        TOOL_ARGUMENTS_MEDIA_TYPE,
      );
      await this.emit(input, laneId, correlationId, eventState, {
        type: "tool.requested",
        payload: {
          operationId,
          toolCallId: call.id,
          name: call.name,
          argumentsRef,
        },
        idempotencyKey: `${eventPrefix}:step:${step}:tool:${call.id}:requested`,
      });
      const callForcedError = forcedError ?? (
        requestToolNames.has(call.name)
          ? undefined
          : this.mowe.catalog.get(call.name) === undefined
            ? undefined
            : `Tool is not available in this model request: ${call.name}`
      );
      preparedCalls.push({
        ...structuredClone(call),
        operationId,
        // Image-producing tools already enforce their own byte/count limits.
        // Keeping those results inline lets Fukai apply its separate image
        // budget without re-reading and duplicating a Mowe artifact.
        ...(this.mowe.catalog.get(call.name)?.metadata.outputKinds.includes("image") === true
          ? { projection: { mode: "inline" as const } }
          : {}),
        ...(callForcedError === undefined ? {} : { forcedError: callForcedError }),
      });
    }

    const messages: { message: ConversationMessage; ref: ArtifactRef }[] = [];
    await this.mowe.execute({
      runId: input.runId,
      laneId,
      workspace: input.workspace,
      calls: preparedCalls,
      artifactStore: this.conversationStore,
      // Keep Mowe's aggregate guard high enough that ordinary tool results
      // remain available for the durable conversation message. Oversized
      // batches are still bounded by Mowe and retain a plain-text artifact.
      limits: { maxOutputBytes: MAX_MOWE_MAX_OUTPUT_BYTES },
      projection: { mode: "auto", maxBytes: MAX_TOOL_RESULT_BYTES },
      ...(input.collaborationMode === "plan"
        ? { allowedEffects: ["read", "compute"] as const }
        : {}),
      ...(this.approve === undefined ? {} : { approve: this.approve }),
      approvalLifecycle: {
        requested: async (context, argumentsHash) => {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "approval.requested",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash,
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${context.call.id}:approval:requested`,
          });
        },
        decided: async (context, decision) => {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "approval.decided",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              decision: decision.decision,
              ...(decision.reason === undefined
                ? {}
                : { reason: boundedRedactedText(decision.reason, 1_024) }),
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${context.call.id}:approval:decided`,
          });
        },
      },
      toolLifecycle: {
        admitted: async (context) => {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "tool.admitted",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash: context.argumentsHash,
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${context.call.id}:admitted`,
          });
        },
        started: async (context) => {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "tool.started",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash: context.argumentsHash,
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${context.call.id}:started`,
          });
        },
      },
      onResult: async (item, index) => {
        // Mowe's retained boundary may already reference a complete source;
        // never read it back to make an unaccounted duplicate in the Ledger.
        const retainedResult = {
          content: redactSensitiveText(item.result.content),
          isError: item.result.isError,
          ...(item.result.images === undefined
            ? {}
            : { images: structuredClone(item.result.images) }),
        } satisfies ToolResult;
        const sourceArtifactRef = item.projection?.artifactRef;
        if (sourceArtifactRef !== undefined) {
          this.artifactAuthorization?.authorize(input.runId, sourceArtifactRef);
        }
        const boundedResult = projectToolResultForContext(
          item,
          retainedResult,
          input.runId,
          this.mowe.catalog.has(ARTIFACT_READ_TOOL_NAME)
            && (
              this.artifactAuthorization === undefined
              || this.artifactAuthorization.hasAny(input.runId)
            ),
        );
        const message: ConversationMessage = {
          role: "tool",
          content: boundedResult.content,
          toolCallId: item.callId,
          toolName: item.name,
          isError: boundedResult.isError,
          ...(boundedResult.images === undefined
            ? {}
            : { images: structuredClone(boundedResult.images) }),
          createdAt: this.clock.now().toISOString(),
        };
        // Transcript and model context intentionally share one bounded artifact.
        const resultRef = await this.writeMessage(message);
        const terminalPayload = {
          operationId: item.operationId,
          toolCallId: item.callId,
          name: item.name,
          contextRef: resultRef,
          ...(sourceArtifactRef === undefined ? {} : { sourceArtifactRef }),
        };
        if (retainedResult.isError) {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "tool.failed",
            payload: {
              ...terminalPayload,
              error: boundedRedactedText(retainedResult.content, 1_024),
              resultRef,
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${item.callId}:failed`,
          });
        } else {
          await this.emit(input, laneId, correlationId, eventState, {
            type: "tool.succeeded",
            payload: {
              ...terminalPayload,
              resultRef,
            },
            idempotencyKey: `${eventPrefix}:step:${step}:tool:${item.callId}:succeeded`,
          });
        }
        // Commit completion facts immediately; model context keeps call order.
        messages[index] = { message, ref: resultRef };
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // Mowe returns a terminal result for every admitted call, including calls
    // cancelled while the batch was in flight. Persist those terminal facts
    // before propagating cancellation so recovery never sees a false pending
    // tool operation.
    throwIfAborted(input.signal);
    return messages;
  }

  private async writeMessage(message: ConversationMessage): Promise<ArtifactRef> {
    return this.conversationStore.put(stableStringify(message), MESSAGE_MEDIA_TYPE);
  }

  private async persistInterruptedStream(
    input: MainLoopInput,
    laneId: LaneId,
    correlationId: string,
    eventState: { watermark: number },
    eventPrefix: string,
    step: number,
    requestId: string,
    progress: MainModelStreamProgress,
    reason: "cancelled" | "timeout" | "error",
  ): Promise<void> {
    if (progress.text.length === 0 && progress.reasoning.length === 0) return;
    const message: ConversationMessage = {
      role: "assistant",
      content: progress.text,
      toolCalls: [],
      ...(progress.reasoning.length === 0 ? {} : { reasoning: progress.reasoning }),
      interrupted: true,
      interruptionReason: reason,
      createdAt: this.clock.now().toISOString(),
    };
    const messageRef = await this.writeMessage(message);
    await this.emit(input, laneId, correlationId, eventState, {
      type: "assistant.message",
      payload: { messageRef },
      idempotencyKey: `${eventPrefix}:step:${step}:assistant:interrupted`,
      causationId: requestId,
    });
  }

  private async emit<K extends EventType>(
    input: MainLoopInput,
    laneId: LaneId,
    correlationId: string,
    eventState: { watermark: number },
    event: {
      type: K;
      payload: EventPayloadMap[K];
      idempotencyKey: string;
      causationId?: string;
    },
  ): Promise<{ eventId: string; globalOffset: number }> {
    const receipt = await this.eventSink.append({
      runId: input.runId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      laneId,
      type: event.type,
      payload: event.payload,
      ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      correlationId,
      idempotencyKey: event.idempotencyKey,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
    if (!Number.isSafeInteger(receipt.globalOffset) || receipt.globalOffset < 1) {
      throw new Error("Event sink returned an invalid globalOffset");
    }
    eventState.watermark = Math.max(eventState.watermark, receipt.globalOffset);
    if (this.eventObserver !== undefined && isCompleteEventReceipt(receipt)) {
      try {
        this.eventObserver(receipt);
      } catch {
        // Sibling-lane sensing is observational and cannot fail the owner lane.
      }
    }
    return receipt;
  }

  private async requestModel(
    request: ModelRequest,
    input: MainLoopInput,
    laneId: LaneId,
    requestId: string,
    progress: MainModelStreamProgress,
    cancellationSignal: AbortSignal,
    modelCapabilities?: ModelCapabilities,
    onDispatch?: () => void,
  ): Promise<ModelResponse> {
    // Check before evaluating the provider call expression.  Passing the
    // promise directly to raceAbort would otherwise invoke a ModelPort once
    // even when a slow model.requested append already consumed the deadline.
    throwIfAborted(cancellationSignal);
    onDispatch?.();
    // `undefined` is intentional here: it records that the capability probe
    // already happened (or that the provider has no usable metadata), so a
    // throwing/expensive capability catalog is never queried twice.
    const prepared = this.model.prepare(request, { capabilities: modelCapabilities });
    if (this.onStreamEvent === undefined || prepared.stream === undefined) {
      return raceAbort(prepared.complete(), cancellationSignal);
    }

    this.publishStream({ type: "stream.start", input, laneId, requestId });
    const iterator = prepared.stream()[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceAbort(iterator.next(), cancellationSignal);
        if (next.done) {
          throw new Error("Model stream ended without a final response");
        }
        const event: ModelStreamEvent = next.value;
        switch (event.type) {
          case "start":
            break;
          case "thinking-start":
            this.publishStream({ type: "stream.thinking-start", input, laneId, requestId });
            break;
          case "thinking-delta":
            if (event.delta.length > 0) {
              progress.reasoning += event.delta;
              this.publishStream({
                type: "stream.thinking-delta",
                input,
                laneId,
                requestId,
                delta: event.delta,
              });
            }
            break;
          case "thinking-end":
            this.publishStream({ type: "stream.thinking-end", input, laneId, requestId });
            break;
          case "text-delta":
            if (event.delta.length > 0) {
              progress.text += event.delta;
              this.publishStream({
                type: "stream.delta",
                input,
                laneId,
                requestId,
                delta: event.delta,
              });
            }
            break;
          case "done":
            return event.response;
          case "error":
            throw event.error;
        }
      }
    } catch (error: unknown) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // A provider iterator cannot displace the durable Main terminal fact.
      }
      throw error;
    }
  }

  private async persistModelRetry(notice: ModelRetryNotice): Promise<void> {
    if (notice.requestId === undefined) {
      throw new Error("Model retry observability requires a durable requestId");
    }
    const context = this.modelRetryContexts.get(notice.requestId);
    if (context === undefined) {
      throw new Error(`Model retry has no active request context: ${notice.requestId}`);
    }
    await this.emit(context.input, context.laneId, context.correlationId, context.eventState, {
      type: "model.retrying",
      payload: {
        requestId: context.requestId,
        model: notice.model,
        attempt: notice.attempt,
        maxAttempts: notice.maxAttempts,
        delayMs: notice.delayMs,
        category: notice.category,
        error: notice.error,
      },
      idempotencyKey: `${context.eventPrefix}:step:${context.step}:model:retrying:${notice.attempt}`,
      causationId: context.requestId,
    });
  }

  private nextModelReservationId(
    input: MainLoopInput,
    laneId: LaneId,
    step: number,
  ): string {
    const base = mainModelReservationBase(input, laneId, step);
    const attempt = (this.modelCallAttempts.get(base) ?? 0) + 1;
    this.modelCallAttempts.set(base, attempt);
    return `${base}:attempt:${attempt}`;
  }

  private publishStream(event: PendingMainStreamEvent): void {
    if (this.onStreamEvent === undefined) return;
    const sequence = this.streamSequences.get(event.requestId) ?? 0;
    this.streamSequences.set(event.requestId, sequence + 1);
    const common = {
      runId: event.input.runId,
      ...(event.input.turnId === undefined ? {} : { turnId: event.input.turnId }),
      laneId: event.laneId,
      requestId: event.requestId,
      sequence,
    };
    let outgoing: MainStreamEvent;
    switch (event.type) {
      case "stream.start":
        outgoing = { ...common, type: event.type };
        break;
      case "stream.thinking-start":
      case "stream.thinking-end":
        outgoing = { ...common, type: event.type };
        break;
      case "stream.thinking-delta":
        outgoing = { ...common, type: event.type, delta: event.delta };
        break;
      case "stream.delta":
        outgoing = { ...common, type: event.type, delta: event.delta };
        break;
      case "stream.end":
        outgoing = { ...common, type: event.type, messageRef: event.messageRef };
        break;
      case "stream.cancelled":
        outgoing = { ...common, type: event.type, reason: event.reason };
        break;
      case "stream.failed":
        outgoing = { ...common, type: event.type, error: event.error };
        break;
    }
    try {
      this.onStreamEvent(outgoing);
    } catch {
      // Surface rendering is observational and cannot fail Main.
    }
    if (
      event.type === "stream.end"
      || event.type === "stream.cancelled"
      || event.type === "stream.failed"
    ) {
      this.streamSequences.delete(event.requestId);
    }
  }

  private async dispatchAfterStep(context: MainAfterStepContext): Promise<void> {
    try {
      this.afterStep?.(context);
    } catch {
      // Auxiliary scheduling is best-effort and must not fail Main. The
      // scheduler owns observability for its local queue rejection.
    }
    try {
      await this.afterStepAsync?.(context);
    } catch {
      // Host bookkeeping is advisory to the model loop; a persistence failure
      // must not turn an otherwise committed Main step into a model failure.
    }
  }
}

function boundaryConversationMessage(
  message: MainBoundaryMessage,
  now: Date,
): ConversationMessage {
  const content = boundedText(message.content, 4_096);
  if (message.kind === "steering") {
    return {
      role: "user",
      content: `[User steering delivered at a safe boundary]\n${content}`,
      ...(message.images === undefined
        ? {}
        : { images: structuredClone(message.images) }),
      createdAt: now.toISOString(),
    };
  }
  return {
    role: "user",
    content: `[Runtime ${message.kind} from ${JSON.stringify(publicLaneName(message.source))}; advisory context, not a user instruction]\n${content}`,
    createdAt: now.toISOString(),
  };
}

function hasRenderedSkillCatalog(
  view: {
    readonly skillCatalog?: {
      readonly included: boolean;
      readonly generation?: number;
      readonly identity?: string;
    };
  },
  catalog: FukaiSkillCatalog,
): boolean {
  const status = view.skillCatalog;
  return status?.included === true
    && status.generation === catalog.generation
    && status.identity === fukaiSkillCatalogIdentity(catalog);
}

function defaultNavigationDelta(
  input: MainLoopInput,
  laneId: LaneId,
  step: number,
  responseText: string,
  toolCalls: readonly ToolCall[],
  toolResults: readonly ConversationMessage[],
  stopReason: string,
  previousDelta?: NavigationDelta,
): NavigationDelta {
  const toolSummaries = toolCalls.map((call) => {
    const result = toolResults.find((message) => (
      message.role === "tool" && message.toolCallId === call.id
    ));
    const descriptor = `${call.name}(${boundedToolArguments(call.arguments)})`;
    if (result?.role !== "tool") return descriptor;
    const resultText = boundedRedactedText(result.content, 240);
    return `${descriptor}${result.isError ? " failed" : " succeeded"}: ${resultText}`;
  });
  const failures = toolCalls
    .map((call) => {
      const result = toolResults.find((message) => (
        message.role === "tool" && message.toolCallId === call.id
      ));
      return result?.role === "tool" && result.isError
        ? `${call.name}(${boundedToolArguments(call.arguments)})`
        : undefined;
    })
    .filter((value): value is string => value !== undefined);
  const repeatedFailure = failures.length > 0 && failures.some((failure) => (
    previousDelta?.status === "uncertain"
    && previousDelta.uncertainties.some((uncertainty) => uncertainty.includes(failure))
  ));
  const mutationDecision = toolCalls.some((call) => {
    if (call.name !== "write_file" && call.name !== "edit" && call.name !== "apply_patch") return false;
    const result = toolResults.find((message) => (
      message.role === "tool" && message.toolCallId === call.id
    ));
    return result?.role === "tool" && !result.isError;
  });
  const hasTools = toolCalls.length > 0;
  const incompleteStop = !hasTools && stopReason !== "stop";
  return {
    boundaryId: `${input.runId}:${laneId}:step:${step}`,
    triggerKind: repeatedFailure
      ? "repeated-failure"
      : mutationDecision
        ? "decision"
        : "normal",
    activeObjective: boundedText(input.activeObjective ?? input.goal.statement, 512),
    actionOrDecision: hasTools
      ? `Call tools: ${toolSummaries.join("; ")}`
      : boundedText(responseText, 512),
    expectedOutcome: hasTools
      ? "Use bounded tool results to advance the active objective"
      : "Return a complete answer that satisfies the mission",
    outcome: failures.length > 0
      ? toolSummaries.filter((summary, index) => failures.some((failure) => summary.startsWith(failure)))[0] ?? failures.join("; ")
      : hasTools
        ? `${toolResults.length} tool result(s) recorded`
        : incompleteStop
          ? `Model stopped with ${stopReason}`
          : "The agent produced a final response",
    status: failures.length > 0 || incompleteStop
      ? "uncertain"
      : hasTools
        ? "progress"
        : "complete",
    uncertainties: incompleteStop
      ? [...failures, `Model stopped with ${stopReason}`]
      : failures,
    openQuestions: [],
  };
}

function boundedToolArguments(arguments_: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(arguments_);
  } catch {
    serialized = "[unserializable]";
  }
  return boundedRedactedText(serialized, 160);
}

export interface MainSystemPromptOptions {
  systemPrompt?: string;
  policy?: Pick<RunPolicy, "tetoEnabled" | "tetoActivation">;
  /** Actual request catalog; prompt previews default to the collaboration mode. */
  tetoControlsAvailable?: boolean;
  collaborationMode?: "default" | "plan";
  laneCapabilityManifests?: readonly LaneCapabilityManifest[];
}

/** Build the stable Main prompt prefix shared by model requests and diagnostics. */
export function effectiveSystemPrompt(
  input: MainSystemPromptOptions,
): string {
  const base = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const manifests = input.laneCapabilityManifests === undefined
    ? ""
    : renderLaneCapabilityManifest(input.laneCapabilityManifests);
  const tetoControlsAvailable = input.tetoControlsAvailable ?? input.collaborationMode !== "plan";
  return [
    base,
    input.systemPrompt !== undefined || input.policy?.tetoEnabled === false
      ? undefined
      : [
          TETO_OVERVIEW,
          input.policy?.tetoActivation === "manual" ? "It is available on demand." : "It starts automatically by default.",
          ...(tetoControlsAvailable ? ["Use teto_stop to stop it and teto_start to restart it."] : []),
        ].join(" "),
    input.collaborationMode === "plan" ? PLAN_MODE_PROMPT : undefined,
    manifests.length === 0 ? undefined : manifests,
  ].filter((part): part is string => part !== undefined).join("\n\n");
}

function resolveContextBudget(
  input: MainLoopInput,
  contextWindowTokens: number | undefined,
  outputReservationTokens: number,
): { budget: FukaiBudget; contextWindowTokens?: number } {
  const knownContextWindow = Number.isSafeInteger(contextWindowTokens)
    && (contextWindowTokens ?? 0) > 0
    ? contextWindowTokens
    : undefined;
  const requestInputCapacity = knownContextWindow === undefined
    ? UNKNOWN_MODEL_REQUEST_INPUT_FALLBACK_TOKENS
    : knownContextWindow - outputReservationTokens;
  if (!Number.isSafeInteger(requestInputCapacity) || requestInputCapacity < 1) {
    throw new Error(
      `Model context window must exceed the ${outputReservationTokens} token output reservation`,
    );
  }
  const requestedInputTokens = input.contextBudget?.maxInputTokens ?? requestInputCapacity;
  if (!Number.isSafeInteger(requestedInputTokens) || requestedInputTokens < 0) {
    throw new Error("contextBudget.maxInputTokens must be a non-negative integer");
  }
  return {
    ...(knownContextWindow === undefined ? {} : { contextWindowTokens: knownContextWindow }),
    budget: {
      maxInputTokens: Math.min(requestedInputTokens, requestInputCapacity),
      maxConversationMessages: input.contextBudget?.maxConversationMessages ?? 200,
      maxArtifacts: input.contextBudget?.maxArtifacts ?? 8,
      maxArtifactBytes: input.contextBudget?.maxArtifactBytes ?? 256 * 1024,
      maxQueries: input.contextBudget?.maxQueries ?? 256,
    },
  };
}

function validateInput(input: MainLoopInput): void {
  if (input.runId.length === 0 || input.model.length === 0 || input.workspace.length === 0) {
    throw new Error("runId, model, and workspace are required");
  }
  if (
    input.initialMessage !== undefined
    && input.initialMessage.trim().length === 0
    && (input.initialImages?.length ?? 0) === 0
  ) {
    throw new Error("initialMessage or initialImages are required");
  }
  validateUserImages(input.initialImages);
  if (input.activeObjective !== undefined && input.activeObjective.trim().length === 0) {
    throw new Error("activeObjective must not be empty");
  }
  if (
    input.goalContextKind !== undefined
    && !["continuation", "objective-updated", "budget-limit"].includes(input.goalContextKind)
  ) {
    throw new Error("goalContextKind is invalid");
  }
  if (input.turnId !== undefined && input.activeObjective === undefined) {
    throw new Error("Interactive Turns require activeObjective");
  }
  if (
    input.initialMessage === undefined
    && (input.initialImages?.length ?? 0) === 0
    && (input.conversationRefs?.length ?? 0) === 0
    && input.turnId === undefined
  ) {
    throw new Error("A new run requires initialMessage or initialImages");
  }
  for (const [name, value] of [
    ["mainStepAllowance", mainStepAllowance(input.policy)],
    ...(input.policy.maxModelTokens === undefined
      ? []
      : [["maxModelTokens", input.policy.maxModelTokens] as const]),
    ["startStep", input.startStep ?? 1],
    ["maxOutputTokens", input.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if ((input.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS) > MAX_MAIN_OUTPUT_TOKENS) {
    throw new Error(`maxOutputTokens must not exceed ${MAX_MAIN_OUTPUT_TOKENS}`);
  }
  const mainRequestTimeoutMs = input.policy.mainRequestTimeoutMs
    ?? DEFAULT_MAIN_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(mainRequestTimeoutMs)
    || mainRequestTimeoutMs < 1
    || mainRequestTimeoutMs > MAX_MAIN_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `mainRequestTimeoutMs must be an integer between 1 and ${MAX_MAIN_REQUEST_TIMEOUT_MS}`,
    );
  }
  const pressureEligibleConversationCount = input.pressureEligibleConversationCount ?? 0;
  if (
    !Number.isSafeInteger(pressureEligibleConversationCount)
    || pressureEligibleConversationCount < 0
    || pressureEligibleConversationCount > (input.conversationRefs?.length ?? 0)
  ) {
    throw new Error(
      "pressureEligibleConversationCount must be a valid incoming conversation prefix",
    );
  }
  const previousEligible = input.conversationRefs?.[pressureEligibleConversationCount - 1];
  const firstProtected = input.conversationRefs?.[pressureEligibleConversationCount];
  if (
    previousEligible !== undefined
    && firstProtected !== undefined
    && previousEligible.groupId !== undefined
    && previousEligible.groupId === firstProtected.groupId
  ) {
    throw new Error("pressureEligibleConversationCount must not split a conversation group");
  }
}

function validateToolCalls(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (call.id.length === 0 || call.name.length === 0) {
      throw new Error("Tool calls require non-empty id and name");
    }
    if (
      call.arguments === null
      || typeof call.arguments !== "object"
      || Array.isArray(call.arguments)
    ) {
      throw new Error(`Tool call arguments must be an object: ${call.id}`);
    }
    if (ids.has(call.id)) {
      throw new Error(`Duplicate tool call id: ${call.id}`);
    }
    ids.add(call.id);
  }
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0),
  };
}

function chargedTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function providerRetryability(error: unknown): boolean | undefined {
  return error instanceof ProviderModelError ? error.retryable : undefined;
}

function isMainRequestTimeout(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    && signal.reason instanceof ProviderModelError
    && signal.reason.category === "timeout";
}

function mainRequestTimeoutError(): ProviderModelError {
  return new ProviderModelError({ category: "timeout", retryable: true });
}

function defaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsedMilliseconds(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function mainModelReservationBase(
  input: MainLoopInput,
  laneId: LaneId,
  step: number,
): string {
  const turn = input.turnId === undefined ? "legacy" : `turn:${input.turnId}`;
  return `${input.runId}:lane:${laneId}:${turn}:step:${step}:provider`;
}

function cacheOutcome(usage: TokenUsage): CacheOutcome {
  if (usage.cacheRead > 0 && usage.cacheWrite > 0) {
    return "hit-write";
  }
  if (usage.cacheRead > 0) {
    return "hit";
  }
  if (usage.cacheWrite > 0) {
    return "write";
  }
  // Providers that do not expose cache counters must not be called misses.
  return "unknown";
}

function boundToolResult(result: ToolResult): ToolResult {
  const bytes = Buffer.from(result.content, "utf8");
  if (bytes.byteLength <= MAX_TOOL_RESULT_BYTES) {
    return {
      content: result.content,
      isError: result.isError,
      ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
    };
  }
  const marker = "\n[TRUNCATED BY NAUSICAA]";
  const markerBytes = Buffer.from(marker, "utf8");
  const prefix = utf8Prefix(
    bytes,
    Math.max(0, MAX_TOOL_RESULT_BYTES - markerBytes.byteLength),
  );
  const content = `${Buffer.from(prefix).toString("utf8")}${marker}`;
  return {
    content,
    isError: result.isError,
    // Provider image blocks have their own validated count/byte/token budget.
    // Counting base64 bytes against the text preview cap would make ordinary
    // screenshots unusable even though the visual context remains bounded.
    ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
  };
}

/**
 * Convert Mowe's bounded projection into the message that enters the next
 * model request. A complete source may remain behind Mowe's artifact pointer;
 * only the projection and that pointer cross the Ledger/context boundary.
 */
function projectToolResultForContext(
  item: Pick<MoweCallResult, "projection">,
  fullResult: ToolResult,
  runId: RunId,
  artifactReadAvailable: boolean,
): ToolResult {
  const projection = item.projection;
  if (projection === undefined) return boundToolResult(fullResult);
  const pointer = projection.artifactRef === undefined
    ? ""
    : artifactReadAvailable
      ? `\n${artifactReadPointer(runId, projection.artifactRef)}`
      : `\n[Full tool result stored as artifact ${projection.artifactRef.id}; ${projection.byteLength} bytes; no artifact reader is available]`;
  // Mowe's byte projection counts the canonical base64 envelope and therefore
  // externalizes most real screenshots. Main deliberately projects text and
  // validated image blocks on separate budgets so a vision-capable provider
  // receives the image while the durable artifact remains lossless.
  const content = (fullResult.images?.length ?? 0) > 0
    ? fullResult.content
    : projection.content ?? "[Tool result projected outside inline context]";
  const images = fullResult.images ?? projection.images;
  const projected: ToolResult = {
    content,
    isError: fullResult.isError,
    ...(images === undefined ? {} : { images: structuredClone(images) }),
  };
  return pointer.length === 0
    ? boundToolResult(projected)
    : boundToolResultWithSuffix(projected, pointer);
}

function withArtifactReadTool(
  tools: readonly AgentTool[],
  store: MainConversationStore,
  authorization?: RunArtifactAuthorization,
): AgentTool[] {
  if (tools.some((tool) => tool.definition.name.trim() === ARTIFACT_READ_TOOL_NAME)) {
    return [...tools];
  }
  if (typeof store.get !== "function") return [...tools];
  return [
    ...tools,
    createArtifactReadTool(
      store as ArtifactReadStore,
      authorization,
    ),
  ];
}

/** Keep an artifact pointer visible even when the preview itself fills the cap. */
function boundToolResultWithSuffix(result: ToolResult, suffix: string): ToolResult {
  const contentBytes = Buffer.from(result.content, "utf8");
  const suffixBytes = Buffer.from(suffix, "utf8");
  if (contentBytes.byteLength + suffixBytes.byteLength <= MAX_TOOL_RESULT_BYTES) {
    return { ...result, content: `${result.content}${suffix}` };
  }
  const marker = "\n[TRUNCATED BY NAUSICAA]";
  const markerBytes = Buffer.from(marker, "utf8");
  if (suffixBytes.byteLength + markerBytes.byteLength >= MAX_TOOL_RESULT_BYTES) {
    return boundToolResult({ ...result, content: suffix });
  }
  const prefix = utf8Prefix(
    contentBytes,
    MAX_TOOL_RESULT_BYTES - suffixBytes.byteLength - markerBytes.byteLength,
  );
  return {
    ...result,
    content: `${Buffer.from(prefix).toString("utf8")}${marker}${suffix}`,
  };
}

/** Return a valid UTF-8 prefix whose byte length never exceeds the limit. */
function utf8Prefix(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const limit = Math.max(0, Math.min(bytes.byteLength, maxBytes));
  if (limit === bytes.byteLength) return bytes;
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function boundedText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 15))}[TRUNCATED]`;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return pending;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface MainRequestDeadline {
  signal: AbortSignal;
  deadlineAt: string;
  dispose(): void;
}

function createMainRequestDeadline(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  startedAt: Date,
): MainRequestDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort(abortReason(parentSignal!));
  };

  if (parentSignal?.aborted === true) {
    controller.abort(abortReason(parentSignal));
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeoutError = new ProviderModelError({ category: "timeout", retryable: true });
    timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  }

  return {
    signal: controller.signal,
    deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isCompleteEventReceipt(value: MainEventReceipt): value is AnyEvent {
  return typeof value.runId === "string"
    && typeof value.laneId === "string"
    && typeof value.type === "string"
    && value.payload !== undefined;
}
