import type { ModelPort } from "../../../src/domain/index.js";

export const BETA_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const BETA_CAPABILITY_SCORER_VERSION = "beta-capability-scorer-v1" as const;

export type BetaCaseId =
  | "compatibility"
  | "bugfix"
  | "resume"
  | "incident-triage"
  | "bash-roundtrip"
  | "file-rewrite"
  | "edge-extension"
  | "multi-agent"
  | "fukai-compaction"
  | "permission-boundary";

export type BetaCaseTier = "compatibility" | "P0" | "P1" | "P2";
export type BetaCaseStatus = "pass" | "fail" | "not-run-budget" | "not-selected";

export interface BetaAttribution {
  readonly project: string;
  readonly sourcePath: string;
  readonly commit: string;
  readonly license: string;
  readonly adopted: readonly string[];
  readonly rejected: readonly string[];
}

export interface BetaFixtureFileManifest {
  readonly path: string;
  readonly role: "source" | "test" | "evidence";
  readonly initialHash: string;
}

export interface BetaCaseManifest {
  readonly id: BetaCaseId;
  readonly version: 1;
  readonly tier: BetaCaseTier;
  readonly enabledTonight: boolean;
  readonly capabilityScore: boolean;
  readonly task: string;
  readonly allowedCapabilities: readonly string[];
  readonly fixtureFiles: readonly BetaFixtureFileManifest[];
  readonly allowedModifyPaths: readonly string[];
  readonly graderVersion: string;
  readonly graderHash: string;
  readonly attribution: readonly BetaAttribution[];
  readonly limits: {
    readonly maxMainSteps: number;
    readonly requestBudgetHint: number;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  };
}

export interface BetaToolTraceEntry {
  readonly laneId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
  /** Paths confirmed by a successful structured tool result; never raw content. */
  readonly observedPaths?: readonly string[];
  /** Bounded non-secret markers confirmed in successful tool output. */
  readonly observedOutputMarkers?: readonly string[];
}

export interface BetaGrade {
  readonly passed: boolean;
  readonly failureCodes: readonly string[];
  readonly assertions: Readonly<Record<string, boolean>>;
}

export interface BetaCaseResult {
  readonly id: BetaCaseId;
  readonly status: BetaCaseStatus;
  readonly capabilityScore: boolean;
  readonly grade: BetaGrade | null;
  readonly runId: string | null;
  readonly completed: boolean;
  readonly steps: number;
  readonly requestCount: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly costUsd: number | null;
  readonly wallClockMs: number;
  readonly tools: readonly string[];
  readonly mutationTools: readonly string[];
  readonly readPaths: readonly string[];
  readonly executionCommit: string;
  readonly fixtureHash: string;
  readonly manifestHash: string;
  readonly scorerHash: string;
  readonly failureCode: string | null;
}

export interface BetaBatchArtifact {
  readonly schemaVersion: typeof BETA_CAPABILITY_SCHEMA_VERSION;
  readonly suite: "beta-capability-minieval";
  readonly model: string;
  readonly executionCommit: string;
  readonly manifestHash: string;
  readonly scorerHash: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly budget: {
    readonly limitUsd: number;
    readonly maxRequests: number;
    readonly requestCount: number;
    readonly costUsd: number | null;
    readonly usage: BetaCaseResult["usage"];
  };
  readonly cases: readonly BetaCaseResult[];
}

export interface BetaModelFactoryContext {
  readonly caseId: BetaCaseId;
  readonly manifest: BetaCaseManifest;
  readonly live: boolean;
}

export type BetaModelFactory = (
  context: BetaModelFactoryContext,
) => ModelPort;
