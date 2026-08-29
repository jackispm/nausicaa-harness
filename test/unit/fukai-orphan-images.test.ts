import { describe, expect, it } from "vitest";

import { FukaiContextProvider, ContentStoreFukaiSource } from "../../src/fukai/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("Fukai orphan tool history", () => {
  it("preserves tool-produced images when rendering an orphan as evidence", async () => {
    const store = new MemoryContentAddressedStore();
    const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
    const ref = await store.put(JSON.stringify({
      role: "tool",
      content: "A screenshot from an earlier step",
      toolCallId: "read-image-call",
      toolName: "read_image",
      isError: false,
      images: [image],
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");

    const view = await new FukaiContextProvider(new ContentStoreFukaiSource(store)).build({
      runId: "orphan-image-run",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "Inspect evidence", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [{ ref, sequence: 1 }],
      artifactSelections: [],
      tools: [],
      upperWatermark: 1,
      policyVersion: "policy-v1",
      budget: {
        maxInputTokens: 4_000,
        maxConversationMessages: 1,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 1,
      },
    });

    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("A screenshot from an earlier step"),
      images: [image],
    });
  });
});
