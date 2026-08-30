import type { AgentTool, JsonSchema } from "../domain/ports.js";
import type {
  MoweAgentTool,
  MoweEffect,
  MoweToolMetadata,
  MoweToolScope,
} from "./types.js";

export const EDGE_MANIFEST_VERSION = 1 as const;

export type EdgeSourceType = "skill" | "mcp" | "plugin";

/** What the host may do after an interrupted or ambiguous invocation. */
export type EdgeRecoverySemantics = "none" | "retry" | "reconcile";

export interface EdgeProvenance {
  /** Package, server, repository, or skill distribution name. */
  readonly upstreamName: string;
  /** Exact upstream version adopted by this manifest. */
  readonly upstreamVersion: string;
  readonly license: string;
  readonly author?: string;
  readonly sourceUri?: string;
}

/**
 * Serializable identity and execution declaration for one edge capability.
 * The hash is host-derived over every field except `manifestHash`.
 */
export interface EdgeManifest {
  readonly manifestVersion: typeof EDGE_MANIFEST_VERSION;
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  readonly capabilityName: string;
  readonly capabilityVersion: string;
  readonly schemaVersion: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly effect: MoweEffect;
  readonly scope: MoweToolScope;
  readonly cancellable: boolean;
  readonly idempotent: boolean;
  readonly recovery: EdgeRecoverySemantics;
  readonly adapterVersion: string;
  /** Adapter-declared upstream/protocol range, retained as provenance. */
  readonly adapterCompatibility: string;
  readonly provenance: EdgeProvenance;
  readonly manifestHash: string;
}

export type EdgeManifestInput = Omit<EdgeManifest, "manifestHash">;

/** Runtime carrier whose immutable definition is pinned to its manifest. */
export interface EdgeCapability {
  readonly manifest: EdgeManifest;
  readonly tool: MoweAgentTool;
}

export interface EdgeDiscoveryContext {
  readonly workspace: string;
  readonly signal?: AbortSignal;
}

export interface EdgeLoadContext extends EdgeDiscoveryContext {}

export type EdgeReleaseReason = "refresh" | "shutdown";

export interface EdgeReleaseContext {
  readonly reason: EdgeReleaseReason;
  readonly signal?: AbortSignal;
}

export type EdgeHealthStatus = "healthy" | "degraded" | "unavailable" | "closed";

export interface EdgeAdapterHealth {
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  readonly status: EdgeHealthStatus;
  readonly checkedAt: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

/**
 * Source adapter boundary. Discovery returns only validated manifests; loading
 * performs progressive work and returns a capability pinned to that manifest.
 */
export interface EdgeAdapter {
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  discover(context: EdgeDiscoveryContext): Promise<readonly EdgeManifest[]>;
  load(manifest: EdgeManifest, context: EdgeLoadContext): Promise<EdgeCapability>;
  health?(): Promise<EdgeAdapterHealth>;
  release?(context: EdgeReleaseContext): Promise<void>;
}

export interface EdgeCapabilitySnapshot {
  readonly generation: number;
  readonly createdAt: string;
  readonly snapshotHash: string;
  readonly capabilities: readonly EdgeCapability[];
}

export interface CreateEdgeCapabilitySnapshotOptions {
  readonly generation: number;
  readonly createdAt: string;
  readonly capabilities: readonly EdgeCapability[];
}

export interface CreateEdgeCapabilityOptions {
  readonly manifest: EdgeManifest;
  readonly tool: AgentTool;
  /** Optional Mowe hints; identity/effect/scope remain manifest-owned. */
  readonly metadata?: MoweToolMetadata;
}

export type EdgeAdapterPhase = "discover" | "validate" | "load" | "execute" | "release";

export type EdgeAdapterErrorCode =
  | "discovery_failed"
  | "manifest_invalid"
  | "load_failed"
  | "execution_failed"
  | "timeout"
  | "cancelled"
  | "transport_closed";

export interface EdgeAdapterFailure {
  readonly code: EdgeAdapterErrorCode;
  readonly phase: EdgeAdapterPhase;
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}
