import { describe, expect, it, vi } from "vitest";

import {
  createEdgeContextContribution,
  createEdgeContextContributionSummary,
} from "../../src/mowe/edge-adapter.js";
import type {
  EdgeContextContribution,
  EdgeContextContributionSummary,
} from "../../src/mowe/edge-types.js";
import {
  createSkillSelection,
  skillSelectionKey,
  type SkillContributionLoader,
} from "../../src/mowe/skills-selection.js";

describe("Mowe explicit Skill selection", () => {
  it("starts empty and publishes deeply immutable snapshots", async () => {
    const skill = summary("skills", "review");
    const selection = createSkillSelection({
      generation: 4,
      contextContributions: [skill, summary("plugins", "context", { sourceType: "plugin" })],
    });
    const snapshot = selection.snapshot();
    const load = vi.fn<SkillContributionLoader>();

    expect(snapshot).toMatchObject({ generation: 4, selected: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.selected)).toBe(true);
    expect((await selection.activate(load, { generation: 4 })).contributions).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("selects deterministically by stable source and contribution identity", () => {
    const zeta = summary("z-source", "one");
    const second = summary("a-source", "two");
    const first = summary("a-source", "one");
    const selection = createSkillSelection({
      generation: 7,
      contextContributions: [zeta, second, first],
    });

    selection.select(7, zeta);
    selection.select(7, second);
    const update = selection.select(7, first);
    expect(update.snapshot.selected.map(({ sourceId, contributionId }) => (
      [sourceId, contributionId]
    ))).toEqual([
      ["a-source", "one"],
      ["a-source", "two"],
      ["z-source", "one"],
    ]);
    expect(skillSelectionKey("ab", "c")).not.toBe(skillSelectionKey("a", "bc"));

    expect(selection.deselect(7, "a-source", "two")).toMatchObject({ changed: true });
    expect(selection.snapshot().selected.map((item) => item.contributionId)).toEqual(["one", "one"]);
    expect(selection.deselect(7, "", "two").diagnostics[0]?.code).toBe("summary-invalid");
    expect(selection.clear(7)).toMatchObject({ changed: true, snapshot: { selected: [] } });
    expect(selection.clear(7)).toMatchObject({ changed: false });
  });

  it("rejects stale, forged, non-Skill, disabled, and excess selections", () => {
    const first = summary("skills", "first");
    const second = summary("skills", "second");
    const disabled = summary("skills", "manual", { disabled: true });
    const plugin = summary("plugins", "plugin", { sourceType: "plugin" });
    const selection = createSkillSelection({
      generation: 3,
      contextContributions: [first, second, disabled, plugin],
    }, { maxSkills: 1 });

    expect(selection.select(2, first).diagnostics[0]?.code).toBe("generation-mismatch");
    expect(selection.select(3, { ...first, description: "forged" }).diagnostics[0]?.code)
      .toBe("summary-forged");
    expect(selection.select(3, summary("skills", "unknown")).diagnostics[0]?.code)
      .toBe("summary-not-found");
    expect(selection.select(3, plugin).diagnostics[0]?.code).toBe("not-a-skill");
    expect(selection.select(3, disabled).diagnostics[0]?.code).toBe("disabled");
    expect(selection.select(3, first)).toMatchObject({ changed: true });
    expect(selection.select(3, second).diagnostics[0]?.code).toBe("skill-limit");
    expect(selection.snapshot().selected).toEqual([first]);
  });

  it("loads each selected Skill at most once in one generation", async () => {
    const skill = summary("skills", "review");
    const selection = createSkillSelection({ generation: 9, contextContributions: [skill] });
    selection.select(9, skill);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async (candidate: EdgeContextContributionSummary) => {
      await gate;
      return loaded(candidate, "Review this change.");
    });

    const first = selection.activate(load, { generation: 9 });
    const second = selection.activate(load, { generation: 9 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.contributions[0]?.body).toBe("Review this change.");
    expect(right.contributions[0]?.body).toBe("Review this change.");
    expect(load).toHaveBeenCalledOnce();
    for (const forbidden of ["tool", "effect", "scope", "requiresApproval", "hostGrants"]) {
      expect(left.contributions[0]).not.toHaveProperty(forbidden);
    }
  });

  it("enforces the aggregate UTF-8 Turn budget with structured diagnostics", async () => {
    const first = summary("skills", "first");
    const second = summary("skills", "second");
    const selection = createSkillSelection({
      generation: 5,
      contextContributions: [second, first],
    }, { maxBytes: 5 });
    selection.select(5, second);
    selection.select(5, first);
    const limits: number[] = [];
    const result = await selection.activate(async (candidate, context) => {
      limits.push(context.maxBodyBytes);
      return loaded(candidate, candidate.contributionId === "first" ? "1234" : "xyz");
    }, { generation: 5 });

    expect(result.contributions.map((item) => item.contributionId)).toEqual(["first"]);
    expect(result.totalBytes).toBe(4);
    expect(limits).toEqual([5, 1]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "byte-limit",
        sourceId: "skills",
        contributionId: "second",
      }),
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it("does not start another load after the Turn byte budget is exhausted", async () => {
    const first = summary("skills", "first");
    const second = summary("skills", "second");
    const selection = createSkillSelection({
      generation: 5,
      contextContributions: [first, second],
    }, { maxBytes: 4 });
    selection.select(5, first);
    selection.select(5, second);
    const load = vi.fn(async (candidate: EdgeContextContributionSummary) => loaded(candidate, "1234"));

    const result = await selection.activate(load, { generation: 5 });
    expect(load).toHaveBeenCalledOnce();
    expect(result.contributions.map((item) => item.contributionId)).toEqual(["first"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "byte-limit", contributionId: "second" }),
    ]);
  });

  it("never invokes the loader for disabled model-invocation summaries", async () => {
    const disabled = summary("skills", "manual", { disabled: true });
    const selection = createSkillSelection({ generation: 2, contextContributions: [disabled] });
    const load = vi.fn<SkillContributionLoader>();

    expect(selection.select(2, disabled).diagnostics[0]).toMatchObject({
      code: "disabled",
      severity: "warning",
    });
    expect((await selection.activate(load, { generation: 2 })).contributions).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("supports cancellation before and during loading", async () => {
    const first = summary("skills", "first");
    const second = summary("skills", "second");
    const preCancelled = createSkillSelection({ generation: 6, contextContributions: [first] });
    preCancelled.select(6, first);
    const preController = new AbortController();
    preController.abort(new Error("stop before load"));
    const load = vi.fn<SkillContributionLoader>();
    const before = await preCancelled.activate(load, {
      generation: 6,
      signal: preController.signal,
    });
    expect(before).toMatchObject({ cancelled: true, diagnostics: [{ code: "load-cancelled" }] });
    expect(load).not.toHaveBeenCalled();

    const active = createSkillSelection({ generation: 6, contextContributions: [first, second] });
    active.select(6, first);
    active.select(6, second);
    const controller = new AbortController();
    let calls = 0;
    const during = await active.activate(async (_candidate, context) => {
      calls += 1;
      controller.abort(new Error("stop in load"));
      throw context.signal?.reason;
    }, { generation: 6, signal: controller.signal });
    expect(calls).toBe(1);
    expect(during.cancelled).toBe(true);
    expect(during.diagnostics[0]?.code).toBe("load-cancelled");
  });

  it("isolates load failures and rejects stale activation without I/O", async () => {
    const broken = summary("skills", "broken");
    const valid = summary("skills", "valid");
    const selection = createSkillSelection({ generation: 11, contextContributions: [valid, broken] });
    selection.select(11, valid);
    selection.select(11, broken);
    const load = vi.fn(async (candidate: EdgeContextContributionSummary) => {
      if (candidate.contributionId === "broken") throw new Error("body changed");
      return loaded(candidate, "valid body");
    });

    const stale = await selection.activate(load, { generation: 10 });
    expect(stale.diagnostics[0]?.code).toBe("generation-mismatch");
    expect(load).not.toHaveBeenCalled();

    const result = await selection.activate(load, { generation: 11 });
    expect(result.contributions.map((item) => item.contributionId)).toEqual(["valid"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "load-failed", contributionId: "broken" }),
    ]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function summary(
  sourceId: string,
  contributionId: string,
  overrides: Partial<Pick<EdgeContextContributionSummary, "disabled" | "sourceType">> = {},
): EdgeContextContributionSummary {
  return createEdgeContextContributionSummary({
    kind: "context",
    sourceId,
    contributionId,
    sourceType: overrides.sourceType ?? "skill",
    name: contributionId,
    description: `${contributionId} instructions`,
    disabled: overrides.disabled ?? false,
  });
}

function loaded(
  selected: EdgeContextContributionSummary,
  body: string,
): EdgeContextContribution {
  return createEdgeContextContribution({ ...selected, body });
}
