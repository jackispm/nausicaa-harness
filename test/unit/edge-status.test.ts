import { describe, expect, it } from "vitest";

import {
  formatEdgeStatus,
  projectRuntimeEdgeStatus,
} from "../../src/cli/edge-status.js";

describe("edge status projection", () => {
  it("keeps a cached health/generation projection synchronous", () => {
    const status = projectRuntimeEdgeStatus({
      enabled: true,
      refreshRequested: false,
      generation: 9,
      toolCount: 2,
      contextCount: 1,
      diagnostics: ["one source degraded"],
      sources: [{
        sourceId: "local-skills",
        type: "skill",
        health: "degraded",
        enabled: true,
        toolCount: 0,
        contextCount: 1,
        diagnostics: ["body omitted"],
        provenance: [],
      }],
    });
    expect(status.generation).toBe(9);
    expect(status.sources[0]).toMatchObject({ health: "degraded", contextCount: 1 });
    expect(formatEdgeStatus(status)).toContain("one source degraded");
    expect(formatEdgeStatus(status)).toContain("generation 9");
  });
});
