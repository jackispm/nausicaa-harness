import { describe, expect, it } from "vitest";

import { FukaiContextProvider } from "../../src/fukai/context-provider.js";
import { ContentStoreFukaiSource } from "../../src/fukai/store-source.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("Fukai runtime Skill catalog", () => {
  it("renders only metadata, carries generation, workspace, and lane-context accounting", async () => {
    const provider = new FukaiContextProvider(
      new ContentStoreFukaiSource(new MemoryContentAddressedStore()),
    );
    const view = await provider.build({
      runId: "catalog-run",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/tmp/workspace\"quoted",
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [{
        name: "skill",
        description: "load",
        parameters: { type: "object", additionalProperties: false },
      }],
      skillCatalog: {
        generation: 9,
        entries: [{ name: "review", description: "  review\n changes <safe> " }],
      },
      upperWatermark: 0,
      policyVersion: "policy-v1",
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 4,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    });

    expect(view.messages[0]?.content).toContain('<available_skills generation="9">');
    expect(view.messages[0]?.content).toContain("review changes &lt;safe&gt;");
    expect(view.messages[0]?.content).not.toContain("SKILL.md");
    expect(view.systemPrompt).not.toContain("/tmp/workspace");
    expect(view.skillCatalog).toMatchObject({
      included: true,
      generation: 9,
      identity: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(view.manifest.slots["lane-context"].itemCount).toBe(1);
    expect(view.cacheKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not render a catalog without its matching skill schema", async () => {
    const provider = new FukaiContextProvider(
      new ContentStoreFukaiSource(new MemoryContentAddressedStore()),
    );
    const view = await provider.build({
      runId: "catalog-run",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/tmp/workspace",
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      skillCatalog: {
        generation: 9,
        entries: [{ name: "review", description: "review changes" }],
      },
      upperWatermark: 0,
      policyVersion: "policy-v1",
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 4,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    });

    expect(view.messages.some((message) => message.content.includes("available_skills"))).toBe(false);
    expect(view.skillCatalog).toMatchObject({
      included: false,
      generation: 9,
      identity: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(view.manifest.slots["lane-context"].itemCount).toBe(0);
  });

  it("keeps the workspace binding private while still validating it", async () => {
    const provider = new FukaiContextProvider(
      new ContentStoreFukaiSource(new MemoryContentAddressedStore()),
    );
    await expect(provider.build({
      runId: "catalog-run",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "inspect", successCriteria: [], hardConstraints: [] },
      workspace: "relative/workspace",
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 0,
      policyVersion: "policy-v1",
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 4,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    })).rejects.toThrow(/absolute path/u);
  });
});
