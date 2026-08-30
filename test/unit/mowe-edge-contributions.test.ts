import { describe, expect, it, vi } from "vitest";

import {
  createEdgeContextContribution,
  createEdgeContextContributionSummary,
} from "../../src/mowe/edge-adapter.js";
import {
  MoweEdgeRegistry,
} from "../../src/mowe/edge-registry.js";
import type {
  EdgeContextContribution,
  EdgeContextContributionSummary,
  EdgeContributionAdapter,
} from "../../src/mowe/edge-types.js";
import {
  projectWorkspaceEdgeSnapshot,
} from "../../src/mowe/workspace-catalog.js";

describe("Mowe context contribution bridge", () => {
  it("keeps context summaries out of model definitions while loading bodies progressively", async () => {
    const load = vi.fn(async (summary: EdgeContextContributionSummary) => (
      createEdgeContextContribution({
        ...summary,
        body: `# ${summary.name}\nUntrusted instructions.`,
      })
    ));
    const adapter = contributionAdapter("skill-host", [summary("skill-host", "release")], load);
    const registry = new MoweEdgeRegistry({ adapters: [adapter] });
    const snapshot = await registry.refresh();

    expect(load).not.toHaveBeenCalled();
    expect(snapshot.catalog.modelDefinitions()).toEqual([]);
    expect(snapshot.contextContributions).toHaveLength(1);
    expect(snapshot.contextContributions[0]).not.toHaveProperty("body");

    const loaded = await registry.loadContribution(snapshot.contextContributions[0]!);
    expect(load).toHaveBeenCalledOnce();
    expect(loaded.body).toContain("Untrusted instructions");
    expect(loaded.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it("keeps host source identity separate from per-contribution identity", async () => {
    const registry = new MoweEdgeRegistry({
      adapters: [contributionAdapter("skills-host", [summary("skills-host", "nested/path")])],
    });
    const snapshot = await registry.refresh();
    const contribution = snapshot.contextContributions[0]!;

    expect(contribution.sourceId).toBe("skills-host");
    expect(contribution.contributionId).toBe("nested/path");
    expect(contribution.sourceId).not.toBe(contribution.contributionId);
    expect(snapshot.edges[0]?.sourceId).toBe("skills-host");
    expect(snapshot.edges[0]?.contextContributions[0]?.contributionId).toBe("nested/path");
  });

  it("retains disabled summaries but fails closed when selected", async () => {
    const disabled = summary("skills-host", "disabled", { disabled: true });
    const registry = new MoweEdgeRegistry({
      adapters: [contributionAdapter("skills-host", [disabled])],
    });
    const snapshot = await registry.refresh();
    expect(snapshot.contextContributions).toEqual([disabled]);
    await expect(registry.loadContribution(disabled)).rejects.toThrow(/disabled/iu);
  });

  it("rejects a forged summary before invoking the contribution loader", async () => {
    const discovered = summary("skills-host", "forged");
    const load = vi.fn(async (candidate: EdgeContextContributionSummary) => ({
      ...candidate,
      body: "body",
    }));
    const registry = new MoweEdgeRegistry({
      adapters: [contributionAdapter("skills-host", [discovered], load)],
    });
    const snapshot = await registry.refresh();
    const forged = { ...snapshot.contextContributions[0]!, description: "changed" };

    await expect(registry.loadContribution(forged)).rejects.toThrow(/active snapshot/iu);
    expect(load).not.toHaveBeenCalled();
  });

  it("isolates invalid and duplicate contributions without hiding valid entries", async () => {
    const valid = summary("skills-host", "valid");
    const duplicate = summary("skills-host", "valid", { name: "other" });
    const invalid = { ...valid, sourceId: "forged-host" } as EdgeContextContributionSummary;
    const registry = new MoweEdgeRegistry({
      adapters: [{
        sourceId: "skills-host",
        sourceType: "skill",
        discoverContributions: async () => [null as unknown as EdgeContextContributionSummary, duplicate, invalid, valid],
        loadContribution: async (candidate) => ({ ...candidate, body: "body" }),
      }],
    });
    const snapshot = await registry.refresh();

    expect(snapshot.contextContributions).toHaveLength(1);
    expect(snapshot.contextContributions[0]?.contributionId).toBe("valid");
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "context-collision", sourceId: "skills-host" }),
      expect.objectContaining({ code: "context-invalid", sourceId: "skills-host" }),
    ]));
  });

  it("keeps an active context snapshot stable across refresh and projects only immutable views", async () => {
    let current = [summary("skills-host", "old")];
    const adapter: EdgeContributionAdapter = {
      sourceId: "skills-host",
      sourceType: "skill",
      discoverContributions: async () => current,
      loadContribution: async (candidate) => ({ ...candidate, body: "old body" }),
    };
    const registry = new MoweEdgeRegistry({ adapters: [adapter] });
    const first = await registry.refresh();
    current = [summary("skills-host", "new")];
    const second = await registry.refresh();

    expect(first.contextContributions.map((item) => item.contributionId)).toEqual(["old"]);
    expect(second.contextContributions.map((item) => item.contributionId)).toEqual(["new"]);
    expect(Object.isFrozen(first.contextContributions)).toBe(true);
    expect(Object.isFrozen(first.contextContributions[0])).toBe(true);
    expect(first.hash).not.toBe(second.hash);

    const projected = projectWorkspaceEdgeSnapshot(first);
    expect(projected.generation).toBe(first.generation);
    expect(projected.tools).toEqual([]);
    expect(projected.contextContributions[0]?.contributionId).toBe("old");
    expect(Object.isFrozen(projected)).toBe(true);

    const loadedFromOldTurn = await registry.loadContribution(first.contextContributions[0]!, {
      snapshot: first,
    });
    expect(loadedFromOldTurn.body).toBe("old body");
  });

  it("produces equal hashes for equivalent insertion and object-key order", async () => {
    const left = contributionAdapter("skills-host", [summary("skills-host", "same")]);
    const right = contributionAdapter("skills-host", [createEdgeContextContributionSummary({
      provenance: {
        sourceUri: "https://example.invalid/skills",
        license: "MIT",
        upstreamVersion: "1.0.0",
        upstreamName: "skills",
      },
      disabled: false,
      description: "A same context item",
      name: "same",
      sourceType: "skill",
      contributionId: "same",
      sourceId: "skills-host",
      kind: "context",
    })]);
    const first = await new MoweEdgeRegistry({ adapters: [left] }).refresh();
    const second = await new MoweEdgeRegistry({ adapters: [right] }).refresh();
    expect(first.hash).toBe(second.hash);
  });

  it("releases context adapters once and clears only the current snapshot", async () => {
    const release = vi.fn(async () => undefined);
    const active = new MoweEdgeRegistry({ adapters: [{
      ...contributionAdapter("skills-host", [summary("skills-host", "close")]),
      release,
    }] });
    const beforeClose = await active.refresh();
    await active.close();
    await active.close();
    expect(release).toHaveBeenCalledOnce();
    expect(active.snapshot().contextContributions).toEqual([]);
    expect(beforeClose.contextContributions).toHaveLength(1);
  });

  it("freezes contribution schema and body boundaries", () => {
    expect(createEdgeContextContribution(summary("skills-host", "metadata-only")))
      .not.toHaveProperty("body");
    const body = createEdgeContextContribution({
      ...summary("skills-host", "freeze"),
      body: "immutable",
    });
    expect(Object.isFrozen(body)).toBe(true);
    expect(body.contentHash).toBeDefined();
    expect(() => createEdgeContextContribution({
      ...summary("skills-host", "bad"),
      body: "different",
      ...(body.contentHash === undefined ? {} : { contentHash: body.contentHash }),
    })).toThrow(/does not match body/u);
  });
});

function contributionAdapter(
  sourceId: string,
  summaries: readonly EdgeContextContributionSummary[],
  loadContribution: EdgeContributionAdapter["loadContribution"] = async (candidate) => ({
    ...candidate,
    body: "body",
  }),
): EdgeContributionAdapter {
  return {
    sourceId,
    sourceType: "skill",
    discoverContributions: async () => summaries,
    loadContribution,
  };
}

function summary(
  sourceId: string,
  contributionId: string,
  overrides: Partial<Pick<EdgeContextContributionSummary, "disabled" | "name">> = {},
): EdgeContextContributionSummary {
  return createEdgeContextContributionSummary({
    kind: "context",
    sourceId,
    contributionId,
    sourceType: "skill",
    name: overrides.name ?? contributionId,
    description: `A ${contributionId} context item`,
    disabled: overrides.disabled ?? false,
    provenance: {
      upstreamName: "skills",
      upstreamVersion: "1.0.0",
      license: "MIT",
      sourceUri: "https://example.invalid/skills",
    },
  });
}
