import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { VERSION } from "../../version.js";
import {
  createSkillsEdgeAdapter,
  SkillLoaderError,
  type SkillsEdgeAdapter,
} from "./skills.js";

// The same package-relative location works in src/ and the published dist/ tree.
export const BUNDLED_SKILL_DIRECTORY = fileURLToPath(new URL("../../../assets/skills/", import.meta.url));

export interface BundledSkillsOptions {
  readonly sourceId: string;
  /** Read the host's discovered user/project names after refreshing those sources. */
  readonly getOverrideNames?: () => ReadonlySet<string>;
}

/** Fixed package assets reuse the guarded loader without granting arbitrary external roots. */
export function createBundledSkillsEdgeAdapter(options: BundledSkillsOptions): SkillsEdgeAdapter {
  const adapter = createSkillsEdgeAdapter({
    sourceId: options.sourceId,
    roots: ["."],
    provenance: {
      upstreamName: "Nausicaa bundled Skills",
      upstreamVersion: VERSION,
      license: "MIT",
      sourceUri: `https://github.com/jackispm/nausicaa-harness/tree/v${VERSION}/assets/skills`,
    },
  });
  const generations: { workspace: string; ids: Set<string> }[] = [];
  return {
    sourceId: adapter.sourceId,
    sourceType: adapter.sourceType,
    async discoverContributions(context) {
      context.signal?.throwIfAborted();
      const workspace = await realpath(context.workspace);
      const summaries = await adapter.discoverContributions({ ...context, workspace: BUNDLED_SKILL_DIRECTORY });
      const overrides = options.getOverrideNames?.() ?? new Set<string>();
      const visible = summaries.filter((summary) => !overrides.has(summary.name));
      context.signal?.throwIfAborted();
      generations.unshift({ workspace, ids: new Set(visible.map((summary) => summary.contributionId)) });
      // Match the underlying loader's two-generation in-flight snapshot window.
      generations.splice(2);
      return Object.freeze(visible);
    },
    async loadContribution(summary, context) {
      context.signal?.throwIfAborted();
      const workspace = await realpath(context.workspace);
      if (!generations.some((generation) => generation.workspace === workspace
        && generation.ids.has(summary.contributionId))) {
        throw new SkillLoaderError("Bundled Skill was not discovered for this workspace");
      }
      return adapter.loadContribution(summary, { ...context, workspace: BUNDLED_SKILL_DIRECTORY });
    },
    async refresh(context) {
      await adapter.refresh?.({ ...context, workspace: BUNDLED_SKILL_DIRECTORY });
    },
    async health() { return adapter.health!(); },
    async release(context) {
      generations.splice(0);
      await adapter.release?.(context);
    },
    diagnostics: () => adapter.diagnostics(),
  };
}
