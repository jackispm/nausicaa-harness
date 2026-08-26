import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../../src/domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiBudgetError,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("FukaiContextProvider", () => {
  it("builds a deterministic context key from external refs", async () => {
    const store = new MemoryContentAddressedStore();
    const first = await putMessage(store, {
      role: "user",
      content: "build the feature",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = await putMessage(store, {
      role: "assistant",
      content: "I will inspect it",
      toolCalls: [],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const artifactA = await store.put("alpha", "text/plain");
    const artifactB = await store.put("beta", "text/plain");
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const base = {
      runId: "run-1",
      laneId: "main",
      laneKind: "main" as const,
      goal: {
        version: 1,
        statement: "Finish the feature",
        successCriteria: ["tests pass"],
        hardConstraints: ["stay in workspace"],
      },
      systemPrompt: "You are Main.",
      conversationRefs: [
        { ref: second, sequence: 2 },
        { ref: first, sequence: 1 },
      ],
      artifactSelections: [
        { ref: artifactB, reason: "B", priority: 1 },
        { ref: artifactA, reason: "A", priority: 1 },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object" as const, additionalProperties: false },
        },
        {
          name: "list_files",
          description: "List files",
          parameters: { type: "object" as const, additionalProperties: false },
        },
      ],
      upperWatermark: 7,
      policyVersion: "v1",
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 10,
        maxArtifacts: 10,
        maxArtifactBytes: 1_000,
        maxQueries: 10,
      },
    };

    const left = await provider.build(base);
    const right = await provider.build({
      ...base,
      artifactSelections: [...base.artifactSelections].reverse(),
    });

    expect(left.cacheKey).toBe(right.cacheKey);
    expect(left.prefixHash).toBe(right.prefixHash);
    expect(left.messages[0]?.content).toBe("build the feature");
    expect(left.messages[1]?.content).toBe("I will inspect it");
    expect(left.messages.at(-1)?.content).toContain("alpha");
    expect(left.messages.at(-1)?.content).toContain("beta");
    expect(left.truncated).toBe(false);

    const reorderedTools = await provider.build({
      ...base,
      tools: [...base.tools].reverse(),
    });
    expect(reorderedTools.prefixHash).not.toBe(left.prefixHash);
  });

  it("makes omissions and byte truncation explicit", async () => {
    const store = new MemoryContentAddressedStore();
    const old = await putMessage(store, {
      role: "user",
      content: "old",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const recent = await putMessage(store, {
      role: "user",
      content: "recent",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const artifact = await store.put("你好，世界", "text/plain");
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));

    const view = await provider.build({
      runId: "run-1",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [{ ref: old, sequence: 1 }, { ref: recent, sequence: 2 }],
      artifactSelections: [{ ref: artifact, reason: "unicode" }],
      tools: [],
      upperWatermark: 1,
      policyVersion: "1",
      budget: {
        maxInputTokens: 500,
        maxConversationMessages: 1,
        maxArtifacts: 1,
        maxArtifactBytes: 5,
        maxQueries: 2,
      },
    });

    expect(view.truncated).toBe(true);
    expect(view.truncations.map((item) => item.kind)).toContain("conversation-message-limit");
    expect(view.truncations.map((item) => item.kind)).toContain("artifact-byte-limit");
    expect(view.messages.some((message) => message.content.includes("�"))).toBe(false);
  });

  it("pins the active Turn objective outside the stable cached prefix", async () => {
    const store = new MemoryContentAddressedStore();
    const old = await putMessage(store, {
      role: "user",
      content: "history that may be omitted",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const request = {
      runId: "run-objective",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Assist in this workspace", successCriteria: [], hardConstraints: [] },
      activeObjective: "Explain the installation steps",
      systemPrompt: "Main",
      conversationRefs: [{ ref: old, sequence: 1 }],
      artifactSelections: [],
      tools: [],
      upperWatermark: 1,
      policyVersion: "1",
      budget: {
        maxInputTokens: 500,
        maxConversationMessages: 0,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    };

    const first = await provider.build(request);
    const second = await provider.build({
      ...request,
      activeObjective: "Review the test failures",
    });

    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]?.content).toContain("Explain the installation steps");
    expect(first.truncations.map((item) => item.kind)).toContain("conversation-message-limit");
    expect(second.prefixHash).toBe(first.prefixHash);
    expect(second.cacheKey).not.toBe(first.cacheKey);
  });

  it("fails when the stable prefix alone exceeds the budget", async () => {
    const store = new MemoryContentAddressedStore();
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));

    await expect(provider.build({
      runId: "run-1",
      laneId: "main",
      laneKind: "main",
      goal: {
        version: 1,
        statement: "x".repeat(1_000),
        successCriteria: [],
        hardConstraints: [],
      },
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 0,
      policyVersion: "1",
      budget: {
        maxInputTokens: 10,
        maxConversationMessages: 0,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    })).rejects.toBeInstanceOf(FukaiBudgetError);
  });
});

async function putMessage(
  store: MemoryContentAddressedStore,
  message: ConversationMessage,
) {
  return store.put(JSON.stringify(message), "application/vnd.nausicaa.conversation-message+json");
}
