import type { AgentTool } from "../domain/ports.js";
import {
  MoweEdgeRegistry,
  type MoweEdgeAdapterLike,
  type MoweEdgeRegistrySnapshot,
} from "../mowe/edge-registry.js";
import type {
  EdgeHostGrant,
  EdgeSourceType,
} from "../mowe/edge-types.js";
import {
  resolveEdgeSettings,
  type EdgeHostGrantSettings,
  type EdgeSettings,
  type EdgeSourceSettings,
  type ResolvedEdgeSettings,
  type ResolvedSettings,
} from "./settings.js";

export interface EdgeFactoryContext {
  readonly workspace: string;
  readonly signal?: AbortSignal;
}

/** Constructors are injected by the composition root to keep config offline and testable. */
export type EdgeAdapterConstructor = (
  source: EdgeSourceSettings,
  context: EdgeFactoryContext,
) => MoweEdgeAdapterLike | Promise<MoweEdgeAdapterLike>;

export interface EdgeAdapterConstructors {
  readonly mcp?: EdgeAdapterConstructor;
  readonly skill?: EdgeAdapterConstructor;
  readonly plugin?: EdgeAdapterConstructor;
}

export interface ConfiguredEdgeCompositionOptions {
  readonly workspace: string;
  /** Accept either the resolved settings object or the nested edge section. */
  readonly settings: ResolvedSettings | ResolvedEdgeSettings | EdgeSettings;
  readonly constructors?: EdgeAdapterConstructors;
  readonly catalog?: MoweEdgeRegistryConstructorOptions["catalog"];
  readonly signal?: AbortSignal;
  readonly startupRefresh?: boolean;
}

type MoweEdgeRegistryConstructorOptions = NonNullable<ConstructorParameters<typeof MoweEdgeRegistry>[0]>;

export type EdgeSourcePlanStatus = "disabled" | "planned" | "constructed" | "rejected" | "failed";

export interface EdgeSourcePlan {
  readonly sourceId: string;
  readonly type: EdgeSourceType;
  readonly enabled: boolean;
  readonly status: EdgeSourcePlanStatus;
  readonly reason?: string;
}

export type EdgeFactoryDiagnosticCode =
  | "edge-disabled"
  | "missing-constructor"
  | "plugin-unsupported"
  | "constructor-failed"
  | "identity-mismatch"
  | "startup-refresh-failed"
  | "orphan-grant";

export interface EdgeFactoryDiagnostic {
  readonly code: EdgeFactoryDiagnosticCode;
  readonly sourceId?: string;
  readonly message: string;
}

export interface ConfiguredEdgeComposition {
  readonly registry: MoweEdgeRegistry;
  readonly sourcePlan: readonly EdgeSourcePlan[];
  readonly diagnostics: readonly EdgeFactoryDiagnostic[];
  readonly snapshot: () => MoweEdgeRegistrySnapshot;
  readonly refresh: (signal?: AbortSignal) => Promise<MoweEdgeRegistrySnapshot>;
  readonly close: () => Promise<void>;
}

/**
 * Build an explicitly configured edge composition. No constructor is invoked
 * for disabled/default settings, and no adapter module is imported here.
 */
export async function createConfiguredEdgeComposition(
  options: ConfiguredEdgeCompositionOptions,
): Promise<ConfiguredEdgeComposition> {
  const edgeSettings = resolveInputEdgeSettings(options.settings);
  const diagnostics: EdgeFactoryDiagnostic[] = [];
  const plans: EdgeSourcePlan[] = [];
  const adapters: MoweEdgeAdapterLike[] = [];
  const constructors = options.constructors ?? {};
  const enabled = edgeSettings.enabled === true;

  for (const source of edgeSettings.sources) {
    if (!enabled || source.enabled === false) {
      plans.push(Object.freeze({
        sourceId: source.sourceId,
        type: source.type,
        enabled: false,
        status: "disabled",
        reason: !enabled ? "edge loading is disabled" : "source is disabled",
      }));
      diagnostics.push(factoryDiagnostic("edge-disabled", source.sourceId, "Edge source is disabled"));
      continue;
    }
    if (source.type === "plugin") {
      plans.push(Object.freeze({
        sourceId: source.sourceId,
        type: source.type,
        enabled: true,
        status: "rejected",
        reason: "plugin constructors are not enabled by the configuration factory",
      }));
      diagnostics.push(factoryDiagnostic("plugin-unsupported", source.sourceId, "Plugin source was rejected; native plugin loading is disabled"));
      continue;
    }
    const constructor = constructors[source.type];
    if (constructor === undefined) {
      plans.push(Object.freeze({
        sourceId: source.sourceId,
        type: source.type,
        enabled: true,
        status: "planned",
        reason: `No ${source.type} constructor was injected`,
      }));
      diagnostics.push(factoryDiagnostic("missing-constructor", source.sourceId, `No ${source.type} edge constructor was injected`));
      continue;
    }
    try {
      const adapter = await constructor(source, { workspace: options.workspace, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      if (adapter.sourceId !== source.sourceId || adapter.sourceType !== source.type) {
        plans.push(Object.freeze({
          sourceId: source.sourceId,
          type: source.type,
          enabled: true,
          status: "failed",
          reason: "constructor returned an adapter with a different identity",
        }));
        diagnostics.push(factoryDiagnostic("identity-mismatch", source.sourceId, "Injected edge constructor returned a mismatched source identity"));
        continue;
      }
      adapters.push(adapter);
      plans.push(Object.freeze({
        sourceId: source.sourceId,
        type: source.type,
        enabled: true,
        status: "constructed",
      }));
    } catch (error) {
      plans.push(Object.freeze({
        sourceId: source.sourceId,
        type: source.type,
        enabled: true,
        status: "failed",
        reason: "constructor failed",
      }));
      diagnostics.push(factoryDiagnostic("constructor-failed", source.sourceId, "Edge constructor failed before adapter I/O"));
    }
  }

  const configuredSourceIds = new Set(edgeSettings.sources.map((source) => source.sourceId));
  for (const grant of edgeSettings.grants) {
    if (!configuredSourceIds.has(grant.sourceId)) {
      diagnostics.push(factoryDiagnostic("orphan-grant", grant.sourceId, "Host grant has no matching configured source"));
    }
  }
  const registry = new MoweEdgeRegistry({
    workspace: options.workspace,
    adapters,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    hostGrants: toHostGrants(edgeSettings.grants),
  });

  const shouldRefresh = options.startupRefresh ?? edgeSettings.refreshOnStart;
  if (enabled && shouldRefresh && adapters.length > 0) {
    try {
      await registry.refresh({
        workspace: options.workspace,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: edgeSettings.refreshTimeoutMs,
      });
    } catch {
      diagnostics.push(factoryDiagnostic("startup-refresh-failed", undefined, "Configured edge startup refresh failed"));
    }
  }

  const stablePlan = Object.freeze([...plans].sort(comparePlan));
  const stableDiagnostics = Object.freeze([...diagnostics].sort(compareDiagnostic));
  let closed = false;
  return {
    registry,
    sourcePlan: stablePlan,
    diagnostics: stableDiagnostics,
    snapshot: () => registry.snapshot(),
    refresh: (signal) => registry.refresh({
      workspace: options.workspace,
      timeoutMs: edgeSettings.refreshTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      await registry.close();
    },
  };
}

function resolveInputEdgeSettings(input: ResolvedSettings | ResolvedEdgeSettings | EdgeSettings): ResolvedEdgeSettings {
  if (isResolvedSettings(input)) return input.edges;
  return resolveEdgeSettings(input, undefined);
}

function isResolvedSettings(input: ResolvedSettings | ResolvedEdgeSettings | EdgeSettings): input is ResolvedSettings {
  return "edges" in input && input.edges !== undefined;
}

function toHostGrants(grants: readonly EdgeHostGrantSettings[]): Readonly<Record<string, EdgeHostGrant>> {
  return Object.fromEntries(grants.map((grant) => [grant.sourceId, {
    effects: [...grant.effects],
    scopes: [...grant.scopes],
    ...(grant.allowWithoutApproval === undefined ? {} : { allowWithoutApproval: grant.allowWithoutApproval }),
  }]));
}

function factoryDiagnostic(code: EdgeFactoryDiagnosticCode, sourceId: string | undefined, message: string): EdgeFactoryDiagnostic {
  return Object.freeze({ code, ...(sourceId === undefined ? {} : { sourceId }), message });
}

function comparePlan(left: EdgeSourcePlan, right: EdgeSourcePlan): number {
  return compareText(left.sourceId, right.sourceId) || compareText(left.type, right.type);
}

function compareDiagnostic(left: EdgeFactoryDiagnostic, right: EdgeFactoryDiagnostic): number {
  return compareText(left.sourceId ?? "", right.sourceId ?? "")
    || compareText(left.code, right.code)
    || compareText(left.message, right.message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
