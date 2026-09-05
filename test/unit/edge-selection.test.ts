import { describe, expect, it } from "vitest";

import {
  createEdgeSelectionController,
  projectEdgeSelectionSnapshot,
} from "../../src/cli/edge-selection.js";
import { formatEdgeStatus } from "../../src/cli/edge-status.js";

const snapshot = (generation: number) => ({
  generation,
  edges: [{
    sourceId: "workspace-skills",
    kind: "skill",
    health: "healthy",
    provenance: [{ upstreamName: "Agent Skills", upstreamVersion: "1" }],
    diagnostics: [{ message: "one diagnostic" }],
  }],
  contextContributions: [
    {
      kind: "context",
      sourceId: "workspace-skills",
      contributionId: "review",
      sourceType: "skill",
      name: "review",
      description: "Review code",
      disabled: false,
      contentHash: "sha256:review",
    },
    {
      kind: "context",
      sourceId: "workspace-skills",
      contributionId: "unsafe",
      sourceType: "skill",
      name: "unsafe",
      description: "Unavailable",
      disabled: true,
    },
  ],
  diagnostics: [{ message: "registry diagnostic" }],
});

describe("edge selection seam", () => {
  it("projects metadata only and keeps disabled Skills fail-closed", () => {
    const projected = projectEdgeSelectionSnapshot(snapshot(3));
    expect(projected.generation).toBe(3);
    expect(projected.skills.map((skill) => skill.name)).toEqual(["review", "unsafe"]);
    expect(projected.skills[0]?.description).toBe("Review code");
    expect(projected.skills[0]).not.toHaveProperty("body");

    const controller = createEdgeSelectionController(() => snapshot(3), {
      selectedSkillIds: ["workspace-skills:unsafe"],
    });
    expect(controller.snapshot().selectedSkillIds).toEqual([]);
    controller.selectSkill("workspace-skills:review");
    expect(controller.snapshot().selectedSkillIds).toEqual(["workspace-skills:review"]);
    expect(controller.selectedContributions()).toEqual([{
      sourceId: "workspace-skills",
      contributionId: "review",
    }]);
    expect(() => controller.selectSkill("workspace-skills:unsafe")).toThrow(/disabled/iu);
  });

  it("keeps the last generation and publishes a stale notice when refresh is cancelled", async () => {
    let rejectRefresh: ((error: unknown) => void) | undefined;
    const controller = createEdgeSelectionController({
      snapshot: () => snapshot(4),
      refresh: (signal) => new Promise((_, reject) => {
        rejectRefresh = reject;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const pending = controller.refresh();
    controller.cancelRefresh();
    rejectRefresh?.(new Error("cancelled"));
    const result = await pending;
    expect(result.generation).toBe(4);
    expect(result.stale).toBe(true);
    expect(result.refreshing).toBe(false);
    expect(result.diagnostics.join(" ")).toMatch(/refresh: cancelled/iu);
  });

  it("formats ANSI-tainted status as plain text for print/JSON callers", () => {
    const status = {
      enabled: true,
      refreshRequested: false,
      generation: 2,
      sources: [{
        sourceId: "\u001b[31mremote\u001b[0m",
        type: "skill",
        status: "configured" as const,
      }],
      diagnostics: ["\u001b[31mbad\u001b[0m"],
      discoveredSkills: [{
        id: "s:r",
        sourceId: "s",
        contributionId: "r",
        name: "\u001b[32mreview\u001b[0m",
        description: "desc",
        disabled: false,
        selected: true,
      }],
    };
    const rendered = formatEdgeStatus(status);
    expect(rendered).not.toContain("\u001b[");
    expect(rendered).toContain("remote");
    expect(rendered).toContain("selected for next Turn");
  });
});
