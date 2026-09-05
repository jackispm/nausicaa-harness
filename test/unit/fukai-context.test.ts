import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../../src/domain/types.js";
import { FUKAI_COMPACTION_MEDIA_TYPE } from "../../src/domain/context.js";
import {
  ContentStoreFukaiSource,
  FukaiBudgetError,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const compactionId = `fukai-compaction:sha256:${"c".repeat(64)}`;

describe("FukaiContextProvider", () => {
  it("includes a verified structured compaction capsule and records provenance", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("old evidence", "text/plain");
    const summary = await store.put(
      JSON.stringify({
        schemaVersion: 1,
        goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
        decisions: ["Use the package manager from package.json"],
        verifiedResults: ["The lockfile is present"],
        openQuestions: ["Does CI require a secret?"],
        sourceRefs: [{ kind: "artifact", ref: source }],
      }),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const view = await provider.build({
      runId: "run-compaction",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 4,
      policyVersion: "policy-v1",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef: summary,
          sourceRefs: [{ kind: "artifact", ref: source }],
          summaryHash: summary.contentHash,
          cursor: "offset:3",
          upperWatermark: 4,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 120,
        },
        summary: {
          schemaVersion: 1,
          goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
          decisions: ["Use the package manager from package.json"],
          verifiedResults: ["The lockfile is present"],
          openQuestions: ["Does CI require a secret?"],
          sourceRefs: [{ kind: "artifact", ref: source }],
        },
      },
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    });

    expect(view.messages[0]?.content).toContain("Use the package manager");
    expect(view.manifest.slots.compaction.status).toBe("ready");
    expect(view.manifest.slots.compaction.state).toBe("present");
    expect(view.manifest.slots.compaction.summaryRef).toEqual(summary);
    expect(view.manifest.slots.compaction.sourceRefs).toEqual([{ kind: "artifact", ref: source }]);
    expect(view.manifest.slots.compaction.summaryHash).toBe(summary.contentHash);
  });

  it("replaces only conversation refs explicitly covered by a ready capsule", async () => {
    const store = new MemoryContentAddressedStore();
    const covered = await putMessage(store, {
      role: "user",
      content: "covered old history",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const uncovered = await putMessage(store, {
      role: "assistant",
      content: "uncovered recent result",
      toolCalls: [],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const goal = {
      version: 1,
      statement: "goal",
      successCriteria: [],
      hardConstraints: [],
    };
    const sourceRefs = [{ kind: "conversation" as const, ref: covered }];
    const compactedSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Keep the verified decision"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs,
    };
    const summary = await store.put(
      JSON.stringify(compactedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));

    const view = await provider.build({
      runId: "run-covered-conversation",
      laneId: "main",
      laneKind: "main",
      goal,
      systemPrompt: "Main",
      conversationRefs: [
        { ref: covered, sequence: 1 },
        { ref: uncovered, sequence: 2 },
      ],
      artifactSelections: [],
      tools: [],
      upperWatermark: 10,
      policyVersion: "policy-v1",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef: summary,
          sourceRefs,
          summaryHash: summary.contentHash,
          cursor: "offset:5",
          upperWatermark: 5,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 20,
        },
        summary: compactedSummary,
      },
      budget: {
        maxInputTokens: 1_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    });

    expect(view.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("Keep the verified decision"),
      "uncovered recent result",
    ]);
    expect(view.messages.some((message) => message.content === "covered old history")).toBe(false);
    expect(view.manifest.slots.inbox.itemCount).toBe(1);
  });

  it("uses a roll-forward base cursor to omit transitively compacted history", async () => {
    const store = new MemoryContentAddressedStore();
    const messages = await Promise.all([1, 2, 3, 4].map((sequence) => putMessage(store, {
      role: "user",
      content: `message ${sequence}`,
      createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    })));
    const previousSummary = await store.put("previous summary", FUKAI_COMPACTION_MEDIA_TYPE);
    const sourceRefs = [
      { kind: "artifact" as const, ref: previousSummary },
      { kind: "conversation" as const, ref: messages[2]! },
    ];
    const compactedSummary = {
      schemaVersion: 1 as const,
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      decisions: ["History through message 3 is represented"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs,
    };
    const summaryRef = await store.put(
      JSON.stringify(compactedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));

    const view = await provider.build({
      runId: "run-roll-forward",
      laneId: "main",
      laneKind: "main",
      goal: compactedSummary.goal,
      systemPrompt: "Main",
      conversationRefs: messages.map((ref, index) => ({ ref, sequence: index + 1 })),
      artifactSelections: [],
      tools: [],
      upperWatermark: 10,
      policyVersion: "policy-v1",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef,
          sourceRefs,
          summaryHash: summaryRef.contentHash,
          cursor: "offset:3",
          upperWatermark: 6,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 20,
        },
        summary: compactedSummary,
      },
      budget: {
        maxInputTokens: 1_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    });

    expect(view.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("History through message 3"),
      "message 4",
    ]);
  });

  it("keeps cursor-crossed deferred conversation source text in the raw Inbox", async () => {
    const store = new MemoryContentAddressedStore();
    const deferred = await putMessage(store, {
      role: "user",
      content: "deferred original message",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const summarized = await putMessage(store, {
      role: "assistant",
      content: "summarized small message",
      toolCalls: [],
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const recent = await putMessage(store, {
      role: "user",
      content: "recent uncompacted message",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    const previousSummary = await store.put(
      "previous summary",
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const sourceRefs = [
      { kind: "artifact" as const, ref: previousSummary },
      { kind: "conversation" as const, ref: summarized },
    ];
    const compactedSummary = {
      schemaVersion: 1 as const,
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      decisions: ["The small message was summarized"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs,
      deferredConversationRefs: [deferred],
    };
    const summaryRef = await store.put(
      JSON.stringify(compactedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));

    const view = await provider.build({
      runId: "run-deferred-conversation",
      laneId: "main",
      laneKind: "main",
      goal: compactedSummary.goal,
      systemPrompt: "Main",
      conversationRefs: [deferred, summarized, recent].map((ref, index) => ({
        ref,
        sequence: index + 1,
      })),
      artifactSelections: [],
      tools: [],
      upperWatermark: 3,
      policyVersion: "policy-v1",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef,
          sourceRefs,
          deferredConversationRefs: [deferred],
          summaryHash: summaryRef.contentHash,
          cursor: "offset:2",
          upperWatermark: 2,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 20,
        },
        summary: compactedSummary,
      },
      budget: {
        maxInputTokens: 1_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    });

    expect(view.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("The small message was summarized"),
      "deferred original message",
      "recent uncompacted message",
    ]);
    expect(view.manifest.slots.inbox.itemCount).toBe(2);
    expect(view.manifest.slots.compaction).toMatchObject({
      deferredConversationRefs: [deferred],
    });
  });

  it("fails closed to bounded raw context for invalid deferred refs", async () => {
    const store = new MemoryContentAddressedStore();
    const summarized = await putMessage(store, {
      role: "user",
      content: "summarized message",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const deferred = await putMessage(store, {
      role: "user",
      content: "deferred message",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const sourceRefs = [{ kind: "conversation" as const, ref: summarized }];
    const goal = { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] };
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const build = async (deferredConversationRefs: readonly typeof deferred[]) => {
      const compactedSummary = {
        schemaVersion: 1 as const,
        goal,
        decisions: [],
        verifiedResults: [],
        openQuestions: [],
        sourceRefs,
        deferredConversationRefs: [...deferredConversationRefs],
      };
      const summaryRef = await store.put(
        JSON.stringify(compactedSummary),
        FUKAI_COMPACTION_MEDIA_TYPE,
      );
      return provider.build({
        runId: "run-invalid-deferred",
        laneId: "main",
        laneKind: "main",
        goal,
        systemPrompt: "Main",
        conversationRefs: [
          { ref: summarized, sequence: 1 },
          { ref: deferred, sequence: 2 },
        ],
        artifactSelections: [],
        tools: [],
        upperWatermark: 2,
        policyVersion: "policy-v1",
        compaction: {
          capsule: {
            schemaVersion: 1,
            compactionId,
            status: "ready",
            summaryRef,
            sourceRefs,
            deferredConversationRefs: [...deferredConversationRefs],
            summaryHash: summaryRef.contentHash,
            cursor: "offset:2",
            upperWatermark: 2,
            goalVersion: 1,
            policyVersion: "policy-v1",
            estimatedTokens: 10,
          },
          summary: compactedSummary,
        },
        budget: {
          maxInputTokens: 1_000,
          maxConversationMessages: 10,
          maxArtifacts: 0,
          maxArtifactBytes: 0,
          maxQueries: 10,
        },
      });
    };

    for (const refs of [[summarized], [deferred, deferred], [{ ...deferred, byteLength: -1 }]]) {
      const view = await build(refs as readonly typeof deferred[]);
      expect(view.messages.map((message) => message.content)).toContain("summarized message");
      expect(view.messages.map((message) => message.content)).toContain("deferred message");
      expect(view.messages.some((message) => message.content.includes("Fukai compaction"))).toBe(false);
      expect(view.manifest.slots.compaction.status).toBe("stale");
      expect(view.manifest.slots.compaction.state).toBe("bounded");
      expect(view.truncations).toContainEqual(expect.objectContaining({ kind: "conversation-shape" }));
    }
  });

  it("does not silently consume stale compaction capsules", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("old evidence", "text/plain");
    const summary = await store.put("summary", FUKAI_COMPACTION_MEDIA_TYPE);
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const view = await provider.build({
      runId: "run-stale-compaction",
      laneId: "main",
      laneKind: "main",
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 2,
      policyVersion: "policy-v2",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "stale",
          summaryRef: summary,
          sourceRefs: [{ kind: "artifact", ref: source }],
          summaryHash: summary.contentHash,
          cursor: "offset:1",
          upperWatermark: 1,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 5,
        },
        summary: {
          schemaVersion: 1,
          goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
          decisions: [],
          verifiedResults: [],
          openQuestions: [],
          sourceRefs: [{ kind: "artifact", ref: source }],
        },
      },
      budget: {
        maxInputTokens: 500,
        maxConversationMessages: 0,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    });

    expect(view.messages).toHaveLength(0);
    expect(view.manifest.slots.compaction.status).toBe("stale");
    expect(view.manifest.slots.compaction.state).toBe("bounded");
  });

  it("fails closed when a ready capsule belongs to a changed policy", async () => {
    const store = new MemoryContentAddressedStore();
    const old = await putMessage(store, {
      role: "user",
      content: "raw policy-sensitive input",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const summary = {
      schemaVersion: 1 as const,
      goal: { version: 1, statement: "goal", successCriteria: [], hardConstraints: [] },
      decisions: ["old policy decision"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: [{ kind: "conversation" as const, ref: old }],
    };
    const summaryRef = await store.put(JSON.stringify(summary), FUKAI_COMPACTION_MEDIA_TYPE);
    const view = await new FukaiContextProvider(new ContentStoreFukaiSource(store)).build({
      runId: "run-policy-change",
      laneId: "main",
      laneKind: "main",
      goal: summary.goal,
      systemPrompt: "Main",
      conversationRefs: [{ ref: old, sequence: 1 }],
      artifactSelections: [],
      tools: [],
      upperWatermark: 2,
      policyVersion: "policy-v2",
      compaction: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef,
          sourceRefs: [{ kind: "conversation", ref: old }],
          summaryHash: summaryRef.contentHash,
          cursor: "offset:1",
          upperWatermark: 1,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 10,
        },
        summary,
      },
      budget: {
        maxInputTokens: 1_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    });

    expect(view.messages.map((message) => message.content)).toContain("raw policy-sensitive input");
    expect(view.messages.map((message) => message.content)).not.toContain(
      expect.stringContaining("old policy decision"),
    );
    expect(view.manifest.slots.compaction.status).toBe("stale");
    expect(view.truncations).toContainEqual(expect.objectContaining({ kind: "conversation-shape" }));
  });

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
    const laterWatermark = await provider.build({
      ...base,
      upperWatermark: base.upperWatermark + 1,
    });

    expect(left.cacheKey).toBe(right.cacheKey);
    expect(left.prefixHash).toBe(right.prefixHash);
    expect(left.messages[0]?.content).toBe("build the feature");
    expect(left.messages[1]?.content).toBe("I will inspect it");
    expect(left.messages.at(-1)?.content).toContain("alpha");
    expect(left.messages.at(-1)?.content).toContain("beta");
    expect(left.truncated).toBe(false);
    expect(left.manifest.schemaVersion).toBe(1);
    expect(left.manifest.slots.goal.state).toBe("present");
    expect(left.manifest.slots.policy.state).toBe("present");
    expect(left.manifest.slots.tools.itemCount).toBe(2);
    expect(left.manifest.slots.inbox.itemCount).toBe(2);
    expect(left.manifest.slots.compaction.state).toBe("empty");
    expect(left.manifest.slots["lane-context"].itemCount).toBe(2);
    expect(left.manifest.prefixHash).toBe(left.prefixHash);
    expect(left.manifest.dynamicHash).toBeTruthy();
    expect(laterWatermark.messages).toEqual(left.messages);
    expect(laterWatermark.dependencyRefs).toEqual(left.dependencyRefs);
    expect(laterWatermark.cacheKey).toBe(left.cacheKey);
    expect(laterWatermark.manifest.dynamicHash).toBe(left.manifest.dynamicHash);
    expect(laterWatermark.manifest.upperWatermark).toBe(8);
    expect(left.manifest.upperWatermark).toBe(7);

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
    expect(first.manifest.slots.inbox).toMatchObject({
      state: "bounded",
      itemCount: 1,
    });
    expect(first.manifest.slots.inbox.estimatedTokens).toBeGreaterThan(0);
    expect(first.truncations.map((item) => item.kind)).toContain("conversation-message-limit");
    expect(second.prefixHash).toBe(first.prefixHash);
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.manifest.prefixHash).toBe(first.manifest.prefixHash);
    expect(second.manifest.dynamicHash).not.toBe(first.manifest.dynamicHash);
  });

  it("keeps a persistent Goal out of ordinary Turns and renders it only at a typed boundary", async () => {
    const store = new MemoryContentAddressedStore();
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const threadGoal = {
      goalId: "thread-goal-1",
      revision: 1,
      objective: "Ship the long-running change",
      status: "active" as const,
      tokenBudget: 500,
      tokensUsed: 12,
      timeUsedSeconds: 3,
      continuationsUsed: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const request = {
      runId: "run-thread-goal-context",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Handle the current user request", successCriteria: [], hardConstraints: [] },
      activeObjective: "Answer this single question",
      threadGoal,
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: 1,
      policyVersion: "1",
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    };

    const ordinary = await provider.build(request);
    const continuation = await provider.build({
      ...request,
      goalContextKind: "continuation" as const,
    });

    expect(ordinary.messages.some((message) => message.content.includes(threadGoal.objective))).toBe(false);
    expect(ordinary.systemPrompt).not.toContain(threadGoal.objective);
    expect(continuation.messages.some((message) => message.content.includes(threadGoal.objective))).toBe(true);
    expect(continuation.messages.some((message) => message.content.includes("<goal_context>"))).toBe(true);
    expect(continuation.cacheKey).not.toBe(ordinary.cacheKey);
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

  it("accounts for images returned by tools in the request token estimate", async () => {
    const store = new MemoryContentAddressedStore();
    const assistant = await putMessage(store, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "image-call", name: "read_image", arguments: { path: "shot.png" } }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const plainResult = await putMessage(store, {
      role: "tool",
      content: "image metadata",
      toolCallId: "image-call",
      toolName: "read_image",
      isError: false,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const imageResult = await putMessage(store, {
      role: "tool",
      content: "image metadata",
      toolCallId: "image-call",
      toolName: "read_image",
      isError: false,
      images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const largeImageResult = await putMessage(store, {
      role: "tool",
      content: "large image metadata",
      toolCallId: "image-call",
      toolName: "read_image",
      isError: false,
      images: [{
        type: "image",
        data: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
        mimeType: "image/png",
      }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const common = {
      runId: "run-tool-image-budget",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Inspect an image", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      artifactSelections: [],
      tools: [],
      upperWatermark: 2,
      policyVersion: "1",
      budget: {
        maxInputTokens: 4_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    };

    const plain = await provider.build({
      ...common,
      conversationRefs: [
        { ref: assistant, sequence: 1 },
        { ref: plainResult, sequence: 2 },
      ],
    });
    const multimodal = await provider.build({
      ...common,
      conversationRefs: [
        { ref: assistant, sequence: 1 },
        { ref: imageResult, sequence: 2 },
      ],
    });
    const large = await provider.build({
      ...common,
      conversationRefs: [
        { ref: assistant, sequence: 1 },
        { ref: largeImageResult, sequence: 2 },
      ],
    });

    expect(multimodal.usage.estimatedInputTokens - plain.usage.estimatedInputTokens).toBe(1_024);
    expect(multimodal.manifest.slots.inbox.estimatedTokens
      - plain.manifest.slots.inbox.estimatedTokens).toBe(1_024);
    expect(large.usage.estimatedInputTokens - plain.usage.estimatedInputTokens)
      .toBeGreaterThanOrEqual(2_048);
  });

  it("keeps newest images under cumulative request count and byte budgets", async () => {
    const store = new MemoryContentAddressedStore();
    const tinyImage = { type: "image" as const, data: "AA==", mimeType: "image/png" as const };
    const oldCount = await putMessage(store, {
      role: "user",
      content: "older count evidence",
      images: [tinyImage, tinyImage, tinyImage, tinyImage],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const recentCount = await putMessage(store, {
      role: "user",
      content: "newest count evidence",
      images: [tinyImage],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const largeImage = {
      type: "image" as const,
      data: Buffer.alloc(3 * 1024 * 1024).toString("base64"),
      mimeType: "image/png" as const,
    };
    const recentLargeImage = {
      type: "image" as const,
      data: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
      mimeType: "image/png" as const,
    };
    const oldBytes = await putMessage(store, {
      role: "user",
      content: "older byte evidence",
      images: [largeImage, largeImage, largeImage],
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const recentBytes = await putMessage(store, {
      role: "user",
      content: "newest byte evidence",
      images: [recentLargeImage],
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const common = {
      runId: "run-image-limits",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Inspect images", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      artifactSelections: [],
      tools: [],
      upperWatermark: 4,
      policyVersion: "1",
      budget: {
        maxInputTokens: 20_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    };

    const countBounded = await provider.build({
      ...common,
      conversationRefs: [
        { ref: oldCount, sequence: 1 },
        { ref: recentCount, sequence: 2 },
      ],
    });
    const byteBounded = await provider.build({
      ...common,
      conversationRefs: [
        { ref: oldBytes, sequence: 3 },
        { ref: recentBytes, sequence: 4 },
      ],
    });

    expect(countBounded.messages.map((message) => messageImages(message).length)).toEqual([3, 1]);
    expect(countBounded.messages[0]?.content).toContain("1 IMAGE BLOCK OMITTED BY FUKAI");
    expect(byteBounded.messages.map((message) => messageImages(message).length)).toEqual([2, 1]);
    expect(byteBounded.messages[0]?.content).toContain("request image budget exceeded");
    expect(byteBounded.truncations).toContainEqual(expect.objectContaining({ kind: "image-budget" }));
    expect(byteBounded.manifest.slots.inbox.state).toBe("bounded");
  });

  it("degrades images only for an explicitly text-only request", async () => {
    const store = new MemoryContentAddressedStore();
    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" as const };
    const user = await putMessage(store, {
      role: "user",
      content: "user visual evidence",
      images: [image],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const assistant = await putMessage(store, {
      role: "assistant",
      content: "inspect it",
      toolCalls: [{ id: "image-call", name: "read_image", arguments: {} }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const tool = await putMessage(store, {
      role: "tool",
      content: "tool visual evidence",
      toolCallId: "image-call",
      toolName: "read_image",
      isError: false,
      images: [image],
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const common = {
      runId: "run-model-image-capability",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Inspect images", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      conversationRefs: [
        { ref: user, sequence: 1 },
        { ref: assistant, sequence: 2 },
        { ref: tool, sequence: 3 },
      ],
      artifactSelections: [],
      tools: [],
      upperWatermark: 3,
      policyVersion: "1",
      budget: {
        maxInputTokens: 5_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    };

    const unknown = await provider.build(common);
    const vision = await provider.build({ ...common, imageInputSupported: true });
    const text = await provider.build({ ...common, imageInputSupported: false });

    expect(unknown.messages.filter((message) => messageImages(message).length > 0)).toHaveLength(2);
    expect(vision.messages).toEqual(unknown.messages);
    expect(text.messages.every((message) => messageImages(message).length === 0)).toBe(true);
    expect(text.messages.filter((message) => message.content.includes("does not support image input")))
      .toHaveLength(2);
    expect(text.truncations.filter((item) => item.kind === "image-budget")).toHaveLength(2);
    expect(text.manifest.slots.inbox.state).toBe("bounded");
    expect(text.cacheKey).not.toBe(vision.cacheKey);
    expect(text.manifest.dynamicHash).not.toBe(vision.manifest.dynamicHash);
  });

  it("bounds interrupted reasoning and never retains a partial tool-call group", async () => {
    const store = new MemoryContentAddressedStore();
    const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
    const reasoning = "private displayed reasoning ".repeat(200);
    const interrupted = await putMessage(store, {
      role: "assistant",
      content: "visible answer prefix",
      reasoning,
      toolCalls: [],
      interrupted: true,
      interruptionReason: "cancelled",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const common = {
      runId: "run-reasoning-budget",
      laneId: "main",
      laneKind: "main" as const,
      goal: { version: 1, statement: "Resume safely", successCriteria: [], hardConstraints: [] },
      systemPrompt: "Main",
      artifactSelections: [],
      tools: [],
      upperWatermark: 3,
      policyVersion: "1",
      budget: {
        maxInputTokens: 10_000,
        maxConversationMessages: 10,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 10,
      },
    };
    const empty = await provider.build({ ...common, conversationRefs: [] });
    const maxInputTokens = empty.usage.estimatedInputTokens + 48;
    const bounded = await provider.build({
      ...common,
      conversationRefs: [{ ref: interrupted, sequence: 1 }],
      budget: { ...common.budget, maxInputTokens },
    });
    const boundedAssistant = bounded.messages.find((message) => message.role === "assistant");

    expect(bounded.usage.estimatedInputTokens).toBeLessThanOrEqual(maxInputTokens);
    expect(boundedAssistant).toMatchObject({
      role: "assistant",
      toolCalls: [],
      interrupted: true,
      interruptionReason: "cancelled",
    });
    if (boundedAssistant?.role !== "assistant") throw new Error("Missing bounded assistant");
    expect(boundedAssistant.content).toContain("visible answer prefix");
    expect(boundedAssistant.content).toContain("TRUNCATED BY FUKAI");
    expect(boundedAssistant.reasoning?.length ?? 0).toBeLessThan(reasoning.length);

    const calls = [
      { id: "call-a", name: "inspect", arguments: { payload: "a".repeat(8_000) } },
      { id: "call-b", name: "inspect", arguments: { payload: "b".repeat(8_000) } },
    ];
    const assistantWithCalls = await putMessage(store, {
      role: "assistant",
      content: "tool plan",
      toolCalls: calls,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const boundedCalls = await provider.build({
      ...common,
      conversationRefs: [{ ref: assistantWithCalls, sequence: 2 }],
      budget: {
        ...common.budget,
        maxInputTokens: empty.usage.estimatedInputTokens + 200,
      },
    });
    expect(boundedCalls.messages.find((message) => message.role === "assistant"))
      .toMatchObject({ toolCalls: [] });

    const orphanedToolResult = await putMessage(store, {
      role: "tool",
      content: "x".repeat(128),
      toolCallId: "call-a",
      toolName: "inspect",
      isError: false,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const boundedHistory = await provider.build({
      ...common,
      conversationRefs: [
        { ref: assistantWithCalls, sequence: 2, groupId: "tool-group" },
        { ref: orphanedToolResult, sequence: 3, groupId: "tool-group" },
      ],
      budget: {
        ...common.budget,
        maxInputTokens: empty.usage.estimatedInputTokens + 64,
      },
    });
    expect(boundedHistory.usage.estimatedInputTokens)
      .toBeLessThanOrEqual(empty.usage.estimatedInputTokens + 64);
    expect(boundedHistory.truncations).toContainEqual(expect.objectContaining({
      kind: "conversation-shape",
    }));
    expect(boundedHistory.messages.every((message) => (
      message.role !== "assistant" || message.toolCalls.length !== 1
    ))).toBe(true);
  });
});

async function putMessage(
  store: MemoryContentAddressedStore,
  message: ConversationMessage,
) {
  return store.put(JSON.stringify(message), "application/vnd.nausicaa.conversation-message+json");
}

function messageImages(message: ConversationMessage) {
  return message.role === "user" || message.role === "tool" ? message.images ?? [] : [];
}
