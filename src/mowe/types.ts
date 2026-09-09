import type { AgentTool, JsonSchema, ToolDefinition, ToolResult } from "../domain/ports.js";
import type { UserImage } from "../domain/images.js";
import type { ArtifactRef, LaneId, RunId, ToolCall } from "../domain/types.js";

export type MoweEffect = "read" | "compute" | "write" | "external";

/**
 * Data classes used by a tool at the Mowe boundary.  These are descriptive
 * capabilities, not a second schema language; AgentTool remains the execution
 * contract and providers still receive its ordinary JSON schema.
 */
export type MoweDataKind = "text" | "json" | "image" | "binary" | "artifact";

/** Where a tool is allowed to derive its state from. */
export type MoweToolScope = "workspace" | "run" | "lane" | "host";

/** Static facts used by Mowe for admission, caching and scheduling. */
export interface MoweToolMetadata {
  effect?: MoweEffect;
  version?: string;
  deterministic?: boolean;
  /**
   * Whether the provider can natively combine several calls into one
   * invocation. Mowe still executes every call independently inside a batch
   * envelope; `false` never rejects a call from `execute({ calls })`.
   */
  supportsBatch?: boolean;
  maxConcurrency?: number;
  /** True when independent calls may overlap without corrupting shared state. */
  concurrencySafe?: boolean;
  /** True when the implementation can emit incremental results. */
  supportsStreaming?: boolean;
  /** Optional cooperative deadline owned by the tool adapter. */
  timeoutMs?: number;
  /** Whether a host/UI approval is required before the call is admitted. */
  requiresApproval?: boolean;
  /** State boundary used for cache and recovery decisions. */
  scope?: MoweToolScope;
  /** Input/output media classes, for capability discovery and routing. */
  inputKinds?: readonly MoweDataKind[];
  outputKinds?: readonly MoweDataKind[];
}

export interface ResolvedMoweToolMetadata {
  effect: MoweEffect;
  version: string;
  deterministic: boolean;
  supportsBatch: boolean;
  concurrencySafe: boolean;
  supportsStreaming: boolean;
  timeoutMs?: number;
  requiresApproval: boolean;
  scope: MoweToolScope;
  inputKinds: readonly MoweDataKind[];
  outputKinds: readonly MoweDataKind[];
  maxConcurrency?: number;
}

export interface MoweToolEntry {
  tool: AgentTool;
  metadata: ResolvedMoweToolMetadata;
}

/** AgentTool-compatible carrier used by adapters to attach catalog metadata. */
export type MoweAgentTool = AgentTool & {
  readonly metadata?: MoweToolMetadata;
};

export interface MoweToolDefinition extends ToolDefinition {
  metadata: ResolvedMoweToolMetadata;
}

/** Stable, model-independent inventory entry for UI/help and host routing. */
export interface MoweCapability {
  name: string;
  description: string;
  metadata: ResolvedMoweToolMetadata;
}

/** `auto` selects a bounded view without discarding the source. */
export type ResultProjectionMode = "auto" | "inline" | "preview" | "summary" | "artifact";

export interface ResultProjectionOptions {
  mode?: ResultProjectionMode;
  /** Maximum UTF-8 bytes in an inline preview or summary excerpt. */
  maxBytes?: number;
}

export interface MoweCall extends ToolCall {
  /** Optional caller-owned identity; otherwise Mowe derives a stable one. */
  operationId?: string;
  /** Runtime-generated failure used when a provider response is truncated. */
  forcedError?: string;
  projection?: ResultProjectionOptions;
}

/** Resource limits applied to one Mowe.execute batch. */
export interface MoweBatchLimits {
  /** Maximum number of calls admitted in one batch. */
  maxCalls?: number;
  /** Maximum UTF-8 bytes in the canonical call envelopes. */
  maxInputBytes?: number;
  /**
   * Maximum bytes retained across the batch. Text-only results use their raw
   * UTF-8 content bytes; results with images use the canonical multimodal
   * payload serialization bytes.
   */
  maxOutputBytes?: number;
  /** Optional wall-clock deadline for the whole batch, in milliseconds. */
  deadlineMs?: number;
}

export const DEFAULT_MOWE_MAX_CALLS = 64;
export const MAX_MOWE_MAX_CALLS = 256;
export const DEFAULT_MOWE_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_MOWE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MOWE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_MOWE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_MOWE_DEADLINE_MS = 60 * 60 * 1000;

/** A put-only store is enough for Mowe to externalize large tool results. */
export interface MoweArtifactStore {
  put(data: string | Uint8Array, mediaType?: string): Promise<ArtifactRef>;
}

export interface MoweExecutionRequest {
  runId: RunId;
  laneId: LaneId;
  workspace: string;
  calls: readonly MoweCall[];
  signal?: AbortSignal;
  concurrency?: number;
  limits?: MoweBatchLimits;
  projection?: ResultProjectionOptions;
  artifactStore?: MoweArtifactStore;
  /** Optional effect allow-list; omitted means the catalog is the boundary. */
  allowedEffects?: readonly MoweEffect[];
  /** Optional scope allow-list for a caller-owned lane/host boundary. */
  allowedScopes?: readonly MoweToolScope[];
  /** Explicit approval seam for tools whose metadata requires approval. */
  approve?: (context: MoweApprovalContext) => MoweApprovalDecision | Promise<MoweApprovalDecision>;
  /** Durable lifecycle recorder for approval requests and decisions. */
  approvalLifecycle?: MoweApprovalLifecycle;
  /** Durable admission/start recorder; failures fail closed before the effect. */
  toolLifecycle?: MoweToolLifecycle;
  /**
   * Called once per retained result, including denied and cancelled calls, in
   * completion order. The response still uses source order. Rejection aborts
   * the batch; execution drains every call and callback before rethrowing the
   * first callback failure. Asynchronous callbacks may overlap.
   */
  onResult?: (result: MoweCallResult, index: number) => void | Promise<void>;
}

export interface MoweApprovalContext {
  runId: RunId;
  laneId: LaneId;
  operationId: string;
  call: MoweCall;
  tool: MoweToolEntry;
  signal?: AbortSignal;
}

export type MoweApprovalDecision = boolean | {
  approved: boolean;
  reason?: string;
};

export type MoweApprovalOutcome = "approved" | "denied" | "cancelled";

export interface MoweApprovalDecisionRecord {
  decision: MoweApprovalOutcome;
  reason?: string;
}

export interface MoweApprovalLifecycle {
  requested: (context: MoweApprovalContext, argumentsHash: string) => void | Promise<void>;
  decided: (
    context: MoweApprovalContext,
    decision: MoweApprovalDecisionRecord,
  ) => void | Promise<void>;
}

/**
 * Durable lifecycle hooks around the external-effect boundary. `admitted` is
 * called only after catalog, scope, schema, and approval checks pass. `started`
 * is called immediately before the tool adapter is invoked. A hook failure is
 * fail-closed and prevents the adapter from running.
 */
export interface MoweToolLifecycle {
  admitted: (context: MoweToolLifecycleContext) => void | Promise<void>;
  started: (context: MoweToolLifecycleContext) => void | Promise<void>;
}

export interface MoweToolLifecycleContext {
  runId: RunId;
  laneId: LaneId;
  operationId: string;
  call: MoweCall;
  tool: MoweToolEntry;
  argumentsHash: string;
  signal?: AbortSignal;
}

export type MoweCallStatus = "succeeded" | "failed" | "cancelled";

export interface MoweResultProjection {
  mode: ResultProjectionMode;
  content?: string;
  /** Images retained by an inline/untruncated multimodal projection. */
  images?: UserImage[];
  artifactRef?: ArtifactRef;
  byteLength: number;
  truncated: boolean;
}

export interface MoweCallResult {
  callId: string;
  name: string;
  operationId: string;
  status: MoweCallStatus;
  result: ToolResult;
  projection?: MoweResultProjection;
  error?: string;
}

export interface MoweExecutionResponse {
  runId: RunId;
  laneId: LaneId;
  results: MoweCallResult[];
  cancelled: boolean;
  status: "succeeded" | "partial" | "failed" | "cancelled";
}

export type MoweSchema = JsonSchema;
