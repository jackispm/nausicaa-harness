import { describe, expect, it } from "vitest";

import { FukaiContextProvider } from "../../src/fukai/context-provider.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { ContentStoreFukaiSource } from "../../src/fukai/store-source.js";
import { sha256 } from "../../src/ledger/hash.js";

describe("Fukai edge Skill context", () => {
  it("renders selected Skills as visibly untrusted data and excludes disabled entries", async () => {
    const provider = new FukaiContextProvider(
      new ContentStoreFukaiSource(new MemoryContentAddressedStore()),
    );
    const body = "Use the read-only review checklist.";
    const view = await provider.build({
      runId: "edge-context-run",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "review", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 0,
      policyVersion: "policy-v1",
      budget: {
        maxInputTokens: 1_000,
        maxConversationMessages: 4,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
      edgeContext: [
        {
          sourceId: "skills",
          contributionId: "review",
          sourceType: "skill",
          name: "review",
          description: "Review guidance",
          body,
          contentHash: sha256(body),
          precedence: 1,
        },
        {
          sourceId: "skills",
          contributionId: "disabled",
          sourceType: "skill",
          name: "disabled",
          description: "Disabled",
          disabled: true,
          body: "must not appear",
          precedence: 2,
        },
      ],
    });
    expect(view.messages[0]?.role).toBe("user");
    expect(view.messages[0]?.content).toContain("untrusted data");
    expect(view.messages[0]?.content).toContain(body);
    expect(view.messages[0]?.content).not.toContain("must not appear");
    expect(view.systemPrompt).not.toContain(body);
    expect(view.cacheKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails closed on forged Skill content hashes", async () => {
    const provider = new FukaiContextProvider(
      new ContentStoreFukaiSource(new MemoryContentAddressedStore()),
    );
    await expect(provider.build({
      runId: "edge-context-forged",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "review", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 0,
      policyVersion: "policy-v1",
      budget: { maxInputTokens: 1000, maxConversationMessages: 0, maxArtifacts: 0, maxArtifactBytes: 0, maxQueries: 0 },
      edgeContext: [{
        sourceId: "skills",
        contributionId: "forged",
        sourceType: "skill",
        name: "forged",
        description: "forged",
        body: "data",
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }],
    })).rejects.toThrow(/hash/i);
  });
});
