import type {
  EdgeSourceSettings,
  ResolvedEdgeSettings,
  ResolvedSettings,
} from "./settings.js";

/** Stable host-owned identity for the implicit project Skill source. */
export const DEFAULT_LOCAL_SKILL_SOURCE_ID = "nausicaa-local-skills";
export const DEFAULT_BUNDLED_SKILL_SOURCE_ID = "nausicaa-bundled-skills";

/** Project roots shared by the Agent Skills, pi, and Nausicaa conventions. */
export const DEFAULT_LOCAL_SKILL_ROOTS = [
  ".agents/skills",
  ".pi/skills",
  "skills",
] as const;

/** The synthetic source needs a valid location even though the constructor uses its roots. */
export const DEFAULT_LOCAL_SKILL_LOCATION = ".";

export interface CliSkillDiscoveryOptions {
  /** The raw CLI switch lets --no-edges explicitly opt out of local discovery. */
  readonly cliEdgesEnabled?: boolean;
}

export interface CliSkillDiscoveryPlan {
  /** Edge settings after adding the implicit local Skill source. */
  readonly edges: ResolvedEdgeSettings;
  /** Undefined when local discovery was explicitly disabled or replaced by an explicit Skill source. */
  readonly localSkillSourceId?: string;
  /** Package-owned fallback Skills, independent of configured project sources. */
  readonly bundledSkillSourceId?: string;
  readonly localSkillRoots: readonly string[];
}

/**
 * Add the default project Skill source without changing external Edge policy.
 *
 * `ResolvedEdgeSettings.enabled` historically gates every configured source.
 * The plan keeps that behavior for configured sources by pinning them disabled
 * when the external gate is off, while the implicit local source remains a
 * read-only metadata source unless --no-edges was explicitly supplied.
 */
export function planCliSkillDiscovery(
  settings: ResolvedSettings,
  options: CliSkillDiscoveryOptions = {},
): CliSkillDiscoveryPlan {
  const configured = settings.edges;
  const localOptOut = options.cliEdgesEnabled === false;
  const hasExplicitSkillSource = configured.sources.some((source) => source.type === "skill");
  const hasReservedSourceId = configured.sources.some(
    (source) => source.sourceId === DEFAULT_LOCAL_SKILL_SOURCE_ID,
  );
  const includeLocalSource = !localOptOut && !hasExplicitSkillSource && !hasReservedSourceId;
  const includeBundledSource = !localOptOut && !configured.sources.some(
    (source) => source.sourceId === DEFAULT_BUNDLED_SKILL_SOURCE_ID,
  );
  const externalEnabled = !localOptOut && configured.enabled === true;

  const configuredSources = configured.sources.map((source) => (
    externalEnabled || source.enabled === false
      ? source
      : Object.freeze({ ...source, enabled: false })
  ));
  const localSource: EdgeSourceSettings | undefined = includeLocalSource
    ? Object.freeze({
        sourceId: DEFAULT_LOCAL_SKILL_SOURCE_ID,
        type: "skill" as const,
        location: DEFAULT_LOCAL_SKILL_LOCATION,
        enabled: true,
      })
    : undefined;
  const sources = Object.freeze([
    ...(localSource === undefined ? [] : [localSource]),
    ...configuredSources,
    ...(includeBundledSource ? [Object.freeze({
      sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID,
      type: "skill" as const,
      location: ".",
      enabled: true,
    })] : []),
  ]);

  return Object.freeze({
    edges: Object.freeze({
      ...configured,
      // The implicit local source needs the registry gate open. Configured
      // external sources remain individually disabled when externalEnabled is false.
      enabled: includeLocalSource || includeBundledSource || externalEnabled,
      sources,
    }),
    ...(localSource === undefined ? {} : { localSkillSourceId: localSource.sourceId }),
    ...(includeBundledSource ? { bundledSkillSourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID } : {}),
    localSkillRoots: Object.freeze([...DEFAULT_LOCAL_SKILL_ROOTS]),
  });
}
