import type { EdgeProvenance } from "../mowe/edge-types.js";

/** A metadata-only Skill row suitable for a user-facing picker. */
export interface EdgeSkillSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly contributionId: string;
  readonly name: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly contentHash?: string;
  readonly provenance?: EdgeProvenance;
}

export interface EdgeSelectionSource {
  readonly sourceId: string;
  readonly type: string;
  readonly health?: string;
  readonly status?: string;
  readonly diagnostics: readonly string[];
  readonly provenance: readonly EdgeProvenance[];
}

export interface EdgeSelectionSnapshot {
  readonly generation: number;
  readonly health?: string;
  readonly skills: readonly EdgeSkillSummary[];
  readonly selectedSkillIds: readonly string[];
  readonly sources: readonly EdgeSelectionSource[];
  readonly provenance: readonly EdgeProvenance[];
  readonly diagnostics: readonly string[];
  readonly stale: boolean;
  readonly refreshing: boolean;
}

/**
 * Structural host seam. The production composition can provide a registry
 * provider, while tests and embedders can provide a tiny fake with the same
 * methods. This controller never mutates settings or grants permissions.
 */
export interface EdgeSelectionProvider {
  readonly snapshot?: () => unknown;
  readonly getSnapshot?: () => unknown;
  readonly status?: () => unknown;
  readonly refresh?: (signal?: AbortSignal) => unknown | Promise<unknown>;
  readonly registry?: {
    snapshot?: () => unknown;
    refresh?: (options?: { readonly signal?: AbortSignal }) => unknown | Promise<unknown>;
  };
}

export interface EdgeSelectionController {
  snapshot(): EdgeSelectionSnapshot;
  selectSkill(id: string): void | Promise<void>;
  deselectSkill(id: string): void | Promise<void>;
  toggleSkill(id: string): void | Promise<void>;
  /** Stable identities to feed a host's per-Turn context selector. */
  selectedContributions(): readonly { readonly sourceId: string; readonly contributionId: string }[];
  selectionPredicate(summary: unknown): boolean;
  refresh(signal?: AbortSignal): Promise<EdgeSelectionSnapshot>;
  cancelRefresh(): void;
}

interface RawRecord {
  readonly [key: string]: any;
}

/** Build a selection controller around a registry/runtime provider. */
export function createEdgeSelectionController(
  provider: EdgeSelectionProvider | (() => unknown),
  options: {
    readonly selectedSkillIds?: readonly string[];
    /** Host callback can bind the next-turn predicate to its runtime provider. */
    readonly onSelectionChange?: (selected: readonly { readonly sourceId: string; readonly contributionId: string }[]) => void | Promise<void>;
  } = {},
): EdgeSelectionController {
  const readSnapshot = (): unknown => typeof provider === "function"
    ? provider()
    : provider.snapshot?.() ?? provider.getSnapshot?.() ?? provider.registry?.snapshot?.() ?? provider.status?.() ?? {};
  const readStatus = (): unknown => typeof provider === "function" ? undefined : provider.status?.();
  const refreshProvider = async (signal: AbortSignal): Promise<unknown> => {
    if (typeof provider === "function") return provider();
    if (provider.refresh !== undefined) return provider.refresh(signal);
    if (provider.registry?.refresh !== undefined) return provider.registry.refresh({ signal });
    return readSnapshot();
  };

  let selectedIds = new Set(options.selectedSkillIds ?? []);
  let current = projectEdgeSelectionSnapshot(readSnapshot(), readStatus(), selectedIds);
  selectedIds = new Set(current.skills
    .filter((skill) => !skill.disabled && selectedIds.has(skill.id))
    .map((skill) => skill.id));
  current = freezeSelectionSnapshot({
    ...current,
    selectedSkillIds: [...selectedIds].sort(compareText),
    skills: current.skills.map((skill) => Object.freeze({ ...skill, selected: selectedIds.has(skill.id) })),
  });
  let refreshController: AbortController | undefined;
  let refreshPromise: Promise<EdgeSelectionSnapshot> | undefined;

  const publish = (value: EdgeSelectionSnapshot, stale = false, refreshing = false): EdgeSelectionSnapshot => {
    const available = new Set(value.skills.filter((skill) => !skill.disabled).map((skill) => skill.id));
    selectedIds = new Set([...selectedIds].filter((id) => available.has(id)));
    current = freezeSelectionSnapshot({
      ...value,
      stale,
      refreshing,
      selectedSkillIds: [...selectedIds].sort(compareText),
      skills: value.skills.map((skill) => Object.freeze({ ...skill, selected: selectedIds.has(skill.id) })),
    });
    return current;
  };

  const findSkill = (id: string): EdgeSkillSummary => {
    const normalized = id.trim();
    const exact = current.skills.find((skill) => skill.id === normalized);
    const aliases = current.skills.filter((skill) => (
      skill.contributionId === normalized || skill.name === normalized
    ));
    const skill = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
    if (skill === undefined) throw new Error(`Unknown Skill: ${id}`);
    if (skill.disabled) throw new Error(`Skill ${skill.name} is disabled and cannot be selected`);
    return skill;
  };

  const setSelected = (id: string, selected: boolean): void => {
    const skill = findSkill(id);
    if (selected) selectedIds.add(skill.id);
    else selectedIds.delete(skill.id);
    publish(current, current.stale, current.refreshing);
    void options.onSelectionChange?.(Object.freeze([...current.skills]
      .filter((skill) => selectedIds.has(skill.id))
      .map((skill) => Object.freeze({
        sourceId: skill.sourceId,
        contributionId: skill.contributionId,
      }))));
  };

  const controller: EdgeSelectionController = {
    snapshot: () => current,
    selectSkill: (id) => setSelected(id, true),
    deselectSkill: (id) => setSelected(id, false),
    toggleSkill: (id) => {
      const skill = findSkill(id);
      setSelected(skill.id, !selectedIds.has(skill.id));
    },
    selectedContributions: () => Object.freeze(current.skills
      .filter((skill) => selectedIds.has(skill.id))
      .map((skill) => Object.freeze({
        sourceId: skill.sourceId,
        contributionId: skill.contributionId,
      }))),
    selectionPredicate: (summary) => {
      if (!isRecord(summary)) return false;
      const sourceId = typeof summary.sourceId === "string" ? summary.sourceId : "";
      const contributionId = typeof summary.contributionId === "string" ? summary.contributionId : "";
      return current.skills.some((skill) => skill.sourceId === sourceId
        && skill.contributionId === contributionId
        && selectedIds.has(skill.id));
    },
    refresh: (signal) => {
      if (refreshPromise !== undefined) return refreshPromise;
      const local = new AbortController();
      refreshController = local;
      const abortFromCaller = (): void => local.abort(signal?.reason ?? new Error("Edge refresh cancelled"));
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      publish(current, current.stale, true);
      refreshPromise = (async () => {
        try {
          const result = await awaitWithAbort(refreshProvider(local.signal), local.signal);
          if (local.signal.aborted) throw local.signal.reason ?? new Error("Edge refresh cancelled");
          const next = projectEdgeSelectionSnapshot(
            result === undefined ? readSnapshot() : result,
            readStatus(),
            selectedIds,
          );
          return publish(next, false, false);
        } catch (error: unknown) {
          const message = local.signal.aborted
            ? "cancelled"
            : error instanceof Error ? error.message : String(error);
          return publish({
            ...current,
            diagnostics: Object.freeze([...current.diagnostics, `refresh: ${message}`]),
          }, true, false);
        } finally {
          signal?.removeEventListener("abort", abortFromCaller);
          refreshController = undefined;
          refreshPromise = undefined;
        }
      })();
      return refreshPromise;
    },
    cancelRefresh: () => {
      refreshController?.abort(new Error("Edge refresh cancelled"));
    },
  };
  return controller;
}

/** Project a registry/status shape into immutable, picker-ready metadata. */
export function projectEdgeSelectionSnapshot(
  snapshot: unknown,
  status?: unknown,
  selectedSkillIds: ReadonlySet<string> | readonly string[] = new Set(),
): EdgeSelectionSnapshot {
  const raw = isRecord(snapshot) ? snapshot : {};
  const statusRaw = isRecord(status) ? status : {};
  const selected = selectedSkillIds instanceof Set ? selectedSkillIds : new Set(selectedSkillIds);
  const generation = boundedGeneration(raw.generation ?? statusRaw.generation);
  const context = Array.isArray(raw.contextContributions)
    ? raw.contextContributions
    : Array.isArray(raw.context)
      ? raw.context
      : Array.isArray(raw.discoveredSkills) ? raw.discoveredSkills : [];
  const skills = context.flatMap((value: unknown): EdgeSkillSummary[] => {
    if (!isRecord(value) || value.kind === "tool"
      || (value.sourceType !== undefined && value.sourceType !== "skill")
      || typeof value.sourceId !== "string"
      || typeof value.name !== "string") return [];
    const contributionId = typeof value.contributionId === "string"
      ? value.contributionId
      : typeof value.id === "string" && value.id.startsWith(`${value.sourceId}:`)
        ? value.id.slice(value.sourceId.length + 1)
        : undefined;
    if (contributionId === undefined || contributionId.length === 0) return [];
    const id = `${value.sourceId}:${contributionId}`;
    return [Object.freeze({
      id,
      sourceId: value.sourceId,
      contributionId,
      name: value.name,
      description: typeof value.description === "string" ? value.description : "",
      disabled: value.disabled === true,
      selected: selected.has(id),
      ...(typeof value.contentHash === "string" ? { contentHash: value.contentHash } : {}),
      ...(isRecord(value.provenance) ? { provenance: freezeProvenance(value.provenance) } : {}),
    })];
  }).sort((left, right) => compareText(left.sourceId, right.sourceId)
    || compareText(left.name, right.name)
    || compareText(left.contributionId, right.contributionId));
  const rawSources = Array.isArray(raw.edges)
    ? raw.edges
    : Array.isArray(statusRaw.sources) ? statusRaw.sources : [];
  const sources = rawSources.flatMap((value: unknown): EdgeSelectionSource[] => {
    if (!isRecord(value) || typeof value.sourceId !== "string") return [];
    const diagnostics = diagnosticStrings(value.diagnostics);
    const provenance = Array.isArray(value.provenance)
      ? value.provenance.filter(isRecord).map((item) => freezeProvenance(item))
      : [];
    return [Object.freeze({
      sourceId: value.sourceId,
      type: typeof value.kind === "string" ? value.kind : typeof value.type === "string" ? value.type : "edge",
      ...(typeof value.health === "string" ? { health: value.health } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      diagnostics: Object.freeze(diagnostics),
      provenance: Object.freeze(provenance),
    })];
  }).sort((left, right) => compareText(left.sourceId, right.sourceId));
  const diagnostics = [
    ...diagnosticStrings(raw.diagnostics),
    ...diagnosticStrings(statusRaw.diagnostics),
  ];
  const provenance = sources.flatMap((source) => source.provenance);
  return freezeSelectionSnapshot({
    generation,
    ...(typeof statusRaw.health === "string" ? { health: statusRaw.health } : {}),
    skills: Object.freeze(skills),
    selectedSkillIds: Object.freeze([...selected].sort(compareText)),
    sources: Object.freeze(sources),
    provenance: Object.freeze(provenance),
    diagnostics: Object.freeze([...new Set(diagnostics)]),
    stale: false,
    refreshing: false,
  });
}

/** Compatibility aliases for hosts that call the surface a Skill selector. */
export const projectSkillSelectionSnapshot = projectEdgeSelectionSnapshot;
export const createSkillSelectionController = createEdgeSelectionController;

function freezeSelectionSnapshot(value: EdgeSelectionSnapshot): EdgeSelectionSnapshot {
  return Object.freeze({
    ...value,
    skills: Object.freeze(value.skills.map((skill) => Object.freeze({
      ...skill,
      ...(skill.provenance === undefined ? {} : { provenance: freezeProvenance(skill.provenance) }),
    }))),
    selectedSkillIds: Object.freeze([...value.selectedSkillIds]),
    sources: Object.freeze(value.sources.map((source) => Object.freeze({
      ...source,
      diagnostics: Object.freeze([...source.diagnostics]),
      provenance: Object.freeze(source.provenance.map((item) => freezeProvenance(item))),
    }))),
    provenance: Object.freeze(value.provenance.map((item) => freezeProvenance(item))),
    diagnostics: Object.freeze([...value.diagnostics]),
  });
}

function diagnosticStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (isRecord(item) && typeof item.message === "string") return [item.message];
    return [];
  });
}

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedGeneration(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeProvenance(value: RawRecord): EdgeProvenance {
  return Object.freeze({
    upstreamName: typeof value.upstreamName === "string" ? value.upstreamName : "unknown",
    upstreamVersion: typeof value.upstreamVersion === "string" ? value.upstreamVersion : "unknown",
    license: typeof value.license === "string" ? value.license : "UNKNOWN",
    ...(typeof value.author === "string" ? { author: value.author } : {}),
    ...(typeof value.sourceUri === "string" ? { sourceUri: value.sourceUri } : {}),
  });
}

async function awaitWithAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Edge refresh cancelled");
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("Edge refresh cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
