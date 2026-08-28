import { describe, expect, it } from "vitest";

import type { AppendEvent, EventEnvelope, EventType } from "../../src/domain/events.js";
import { FUKAI_COMPACTION_MEDIA_TYPE } from "../../src/domain/context.js";
import type { ArtifactRef, Goal, RunPolicy } from "../../src/domain/types.js";
import {
  FukaiCore,
  FukaiStaleError,
  compactionIntegrityReasons,
  projectFukai,
  ContentStoreFukaiSource,
} from "../../src/fukai/index.js";
import type { FukaiSource } from "../../src/fukai/types.js";
import {
  IdempotencyConflictError,
  MemoryLedger,
} from "../../src/ledger/index.js";
import { sha256, stableJson } from "../../src/ledger/hash.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Inspect the workspace",
  successCriteria: ["return verified evidence"],
  hardConstraints: ["stay in workspace"],
};

const policy: RunPolicy = {
  maxMainSteps: 10,
  maxModelTokens: 5_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

const compactionId = `fukai-compaction:sha256:${"c".repeat(64)}`;
const staleCompactionId = `fukai-compaction:sha256:${"d".repeat(64)}`;
const rollForwardCompactionId = `fukai-compaction:sha256:${"f".repeat(64)}`;

describe("FukaiCore", () => {
  it("queries a fixed watermark with stable cursors and records a bounded audit", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append({
      ...command("lane.status", { status: "running" }),
      visibility: "lane",
    });
    await ledger.append(command("lane.status", { status: "waiting", reason: "evidence" }));
    const upperWatermark = await ledger.watermark();

    const first = await core.queryEvents({
      queryId: "query-1",
      runId: "run-1",
      laneId: "main",
      reason: "inspect lifecycle",
      upperWatermark,
      filters: { types: ["lane.status"] },
      budget: { maxEvents: 1, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });
    expect(first.status).toBe("truncated");
    expect(first.truncated).toBe(true);
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).not.toBe(first.cursor);
    expect(first.evidenceRefs).toEqual([first.events[0]!.contentHash]);

    const second = await core.queryEvents({
      queryId: "query-2",
      runId: "run-1",
      laneId: "main",
      reason: "continue lifecycle",
      cursor: first.nextCursor,
      upperWatermark,
      filters: { types: ["lane.status"] },
      budget: { maxEvents: 2, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });
    expect(second.status).toBe("ok");
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.globalOffset).toBeGreaterThan(first.events[0]!.globalOffset);
    const audits = (await ledger.read({ runId: "run-1" })).filter((event) => event.type === "fukai.query.audit");
    expect(audits).toHaveLength(2);
    expect(audits[0]!.payload).toMatchObject({ queryId: "query-1", status: "truncated" });
  });

  it("enforces lane visibility and makes stale snapshots explicit", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append({
      ...command("lane.status", { status: "running" }),
      visibility: "lane",
    });
    const upperWatermark = await ledger.watermark();

    const denied = await core.queryEvents({
      runId: "run-1",
      laneId: "teto",
      reason: "check main state",
      upperWatermark,
      filters: { types: ["lane.status"] },
      budget: { maxEvents: 5, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });
    expect(denied.status).toBe("denied");
    expect(denied.events).toEqual([]);
    expect(denied.deniedCount).toBe(1);

    const stale = await core.queryEvents({
      runId: "run-1",
      laneId: "main",
      reason: "read future",
      upperWatermark: upperWatermark + 100,
      budget: { maxEvents: 1, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });
    expect(stale.status).toBe("stale");
    expect(stale.truncated).toBe(false);
    expect(stale.nextCursor).toBe(stale.cursor);
  });

  it("keeps one audit for an idempotent query retry and rejects queryId reuse", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("lane.status", { status: "running" }));
    const upperWatermark = await ledger.watermark();
    const request = {
      queryId: "retry-query",
      runId: "run-1",
      laneId: "main",
      reason: "read status once",
      upperWatermark,
      filters: { types: ["lane.status"] as EventType[] },
      budget: {
        maxEvents: 5,
        maxBytes: 10_000,
        maxTokens: 2_000,
        maxWallClockMs: 1_000,
      },
    };

    const [first, retry] = await Promise.all([
      core.queryEvents(request),
      core.queryEvents(request),
    ]);
    expect(retry.resultHash).toBe(first.resultHash);
    expect(retry.evidenceRefs).toEqual(first.evidenceRefs);
    expect((await ledger.read({ runId: "run-1" })).filter(
      (event) => event.type === "fukai.query.audit",
    )).toHaveLength(1);

    await expect(core.queryEvents({
      ...request,
      reason: "a different request",
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("reads bounded artifacts and persists a monotonic lane checkpoint", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("0123456789", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));
    const upperWatermark = await ledger.watermark();

    const artifact = await core.readArtifact({
      runId: "run-1",
      laneId: "main",
      reason: "inspect bounded output",
      ref,
      range: { offset: 2, length: 8 },
      upperWatermark,
      budget: { maxBytes: 3, maxTokens: 10, maxWallClockMs: 1_000 },
    });
    expect(artifact.status).toBe("truncated");
    expect(artifact.content).toBe("234");
    expect(artifact.evidenceRefs).toEqual([ref.contentHash]);

    const checkpoint = await core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: goal.version,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    });
    expect(checkpoint.payload.stateHash).toMatch(/^sha256:/);
    expect(projectFukai(await ledger.read(), "run-1", "main").latestCheckpoint).toEqual(checkpoint);
    await expect(core.readCheckpoint({
      runId: "run-1",
      laneId: "main",
      goalVersion: 1,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({ status: "ready", reasons: [] });

    await expect(core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: "offset:0",
      upperWatermark,
      goalVersion: goal.version,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    })).rejects.toBeInstanceOf(FukaiStaleError);
  });

  it("rejects a caller-supplied checkpoint hash that does not match its refs", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("state", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));
    await expect(core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
      stateHash: "sha256:wrong",
    })).rejects.toThrow(/stateHash/);
  });

  it("scopes checkpoint idempotency to the lane", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const upperWatermark = await ledger.watermark();
    const base = {
      runId: "run-1",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [],
      policyVersion: "policy-v1",
    };

    const main = await core.commitCheckpoint({ ...base, laneId: "main" });
    const teto = await core.commitCheckpoint({ ...base, laneId: "teto" });

    expect(main.idempotencyKey).toContain(":main:");
    expect(teto.idempotencyKey).toContain(":teto:");
    expect(main.eventId).not.toBe(teto.eventId);
  });

  it("serializes concurrent checkpoint commits so the cursor cannot regress", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("lane.status", { status: "running" }));
    const upperWatermark = await ledger.watermark();
    const base = {
      runId: "run-1",
      laneId: "main",
      upperWatermark,
      goalVersion: 1,
      stateRefs: [],
      policyVersion: "policy-v1",
    };

    const results = await Promise.allSettled([
      core.commitCheckpoint({ ...base, cursor: `offset:${upperWatermark}` }),
      core.commitCheckpoint({ ...base, cursor: "offset:1" }),
    ]);

    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    if (results[1]!.status === "rejected") {
      expect(results[1]!.reason).toBeInstanceOf(FukaiStaleError);
    }
    const projected = projectFukai(await ledger.read(), "run-1", "main");
    expect(projected.checkpoints).toHaveLength(1);
    expect(projected.latestCheckpoint?.payload.cursor).toBe(`offset:${upperWatermark}`);
  });

  it("falls back from a damaged latest checkpoint with an explicit reason", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const upperWatermark = await ledger.watermark();
    const valid = await core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [],
      policyVersion: "policy-v1",
    });
    const damaged = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "fukai.checkpoint.committed",
      payload: {
        cursor: "offset:2",
        upperWatermark: 2,
        goalVersion: 1,
        stateRefs: [],
        stateHash: "sha256:damaged",
        policyVersion: "policy-v1",
      },
      correlationId: "test:damaged-checkpoint",
      idempotencyKey: "test:damaged-checkpoint",
      visibility: "lane",
    });

    const projected = projectFukai(await ledger.read(), "run-1", "main");
    expect(projected.latestCheckpoint?.eventId).toBe(valid.eventId);
    expect(projected.invalidCheckpoints).toMatchObject([{
      checkpoint: { eventId: damaged.eventId },
      reasons: ["state-hash-mismatch"],
    }]);
    await expect(core.readCheckpoint({
      runId: "run-1",
      laneId: "main",
      goalVersion: 1,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      reasons: [`checkpoint-fallback:${damaged.eventId}:state-hash-mismatch`],
      dependenciesVerified: true,
      checkpoint: { eventId: valid.eventId },
    });
  });

  it("keeps a query pinned to its upper watermark", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const upperWatermark = await ledger.watermark();
    await ledger.append(command("lane.status", { status: "running" }));

    const result = await core.queryEvents({
      runId: "run-1",
      laneId: "main",
      reason: "read stable snapshot",
      upperWatermark,
      filters: { types: ["lane.status"] },
      budget: { maxEvents: 10, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });

    expect(result.status).toBe("not-found");
    expect(result.events).toEqual([]);
  });

  it("matches event references by ID or content hash and canonicalizes filters", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const status = await ledger.append(command("lane.status", { status: "running" }));
    const upperWatermark = await ledger.watermark();

    const byId = await core.queryEvents({
      runId: "run-1",
      laneId: "main",
      reason: "read by event id",
      upperWatermark,
      filters: { eventRefs: [status.eventId] },
      budget: { maxEvents: 10, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });
    const byHash = await core.queryEvents({
      runId: "run-1",
      laneId: "main",
      reason: "read by event hash",
      upperWatermark,
      filters: { eventIds: [status.contentHash] },
      budget: { maxEvents: 10, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    });

    expect(byId.events.map((event) => event.eventId)).toEqual([status.eventId]);
    expect(byHash.events.map((event) => event.eventId)).toEqual([status.eventId]);
  });

  it("requires a visible ledger reference before reading an artifact", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("unreferenced", "text/plain");
    const upperWatermark = await ledger.watermark();

    const missing = await core.readArtifact({
      runId: "run-1",
      laneId: "main",
      reason: "read missing reference",
      ref,
      range: { offset: 0, length: 20 },
      upperWatermark,
      budget: { maxBytes: 20, maxTokens: 20, maxWallClockMs: 1_000 },
    });
    expect(missing.status).toBe("not-found");
    expect(missing.content).toBe("");
  });

  it("denies an artifact referenced only by another lane", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("private", "text/plain");
    await ledger.append({
      ...command("assistant.message", { messageRef: ref }, "teto"),
      visibility: "lane",
    });
    const upperWatermark = await ledger.watermark();

    const denied = await core.readArtifact({
      runId: "run-1",
      laneId: "main",
      reason: "read private reference",
      ref,
      range: { offset: 0, length: 20 },
      upperWatermark,
      budget: { maxBytes: 20, maxTokens: 20, maxWallClockMs: 1_000 },
    });
    expect(denied.status).toBe("denied");
    expect(denied.evidenceRefs).toEqual([]);
  });

  it("does not let a checkpoint grant access to another lane's artifact", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("private", "text/plain");
    await ledger.append({
      ...command("assistant.message", { messageRef: ref }, "main"),
      visibility: "lane",
    });
    const upperWatermark = await ledger.watermark();

    await expect(core.commitCheckpoint({
      runId: "run-1",
      laneId: "teto",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    })).rejects.toThrow(/no pre-existing visible reference/);

    expect((await ledger.read({ runId: "run-1" })).some((event) => (
      event.type === "fukai.checkpoint.committed"
    ))).toBe(false);
    await expect(core.readArtifact({
      runId: "run-1",
      laneId: "teto",
      reason: "verify private ref stays private",
      ref,
      range: { offset: 0, length: 20 },
      upperWatermark: await ledger.watermark(),
      budget: { maxBytes: 20, maxTokens: 20, maxWallClockMs: 1_000 },
    })).resolves.toMatchObject({ status: "denied", content: "" });
  });

  it("returns an explicit truncation when the wall-clock budget expires", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const delegate = new ContentStoreFukaiSource(store);
    const source: FukaiSource = {
      hasArtifact: (ref, options) => delegate.hasArtifact(ref, options),
      readConversation: (ref, options) => delegate.readConversation(ref, options),
      readArtifact: async (ref, range, options) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return delegate.readArtifact(ref, range, options);
      },
    };
    const core = new FukaiCore(ledger, source);
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("slow", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));

    const result = await core.readArtifact({
      runId: "run-1",
      laneId: "main",
      reason: "bounded slow read",
      ref,
      range: { offset: 0, length: 4 },
      upperWatermark: await ledger.watermark(),
      budget: { maxBytes: 4, maxTokens: 4, maxWallClockMs: 1 },
    });

    expect(result).toMatchObject({ status: "truncated", truncated: true, content: "" });
  });

  it("marks a checkpoint stale when a state reference disappears or versions change", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const delegate = new ContentStoreFukaiSource(store);
    let available = true;
    const source: FukaiSource = {
      hasArtifact: async (ref, options) => available && await delegate.hasArtifact(ref, options),
      readConversation: (ref, options) => delegate.readConversation(ref, options),
      readArtifact: (ref, range, options) => delegate.readArtifact(ref, range, options),
    };
    const core = new FukaiCore(ledger, source);
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("state", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));
    const upperWatermark = await ledger.watermark();
    await core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    });

    available = false;
    await expect(core.readCheckpoint({
      runId: "run-1",
      laneId: "main",
      goalVersion: 1,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      reasons: [`missing-state-ref:${ref.id}`],
    });

    await expect(core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    })).rejects.toBeInstanceOf(FukaiStaleError);

    await expect(core.readCheckpoint({
      runId: "run-1",
      laneId: "main",
      goalVersion: 2,
      policyVersion: "policy-v2",
    })).resolves.toMatchObject({
      status: "stale",
      reasons: expect.arrayContaining([
        "goal-version-changed",
        "policy-version-changed",
        `missing-state-ref:${ref.id}`,
      ]),
    });
  });

  it("projects Fukai events deterministically even when input is reverse ordered", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("state", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));
    const upperWatermark = await ledger.watermark();
    await core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [ref, ref],
      policyVersion: "policy-v1",
    });
    const events = await ledger.read();
    const forward = projectFukai(events, "run-1", "main");
    const reverse = projectFukai([...events].reverse(), "run-1", "main");
    expect(reverse).toEqual(forward);
    expect(forward.latestCheckpoint?.payload.stateRefs).toHaveLength(1);
  });

  it("commits and restores a verified compaction capsule", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const source = await store.put("verified source", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: source }));
    const upperWatermark = await ledger.watermark();
    const summaryBody = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Use the existing workspace"],
      verifiedResults: ["The source was read"],
      openQuestions: ["What remains to inspect?"],
      sourceRefs: [{ kind: "artifact" as const, ref: source }],
    };
    const summaryRef = await store.put(
      JSON.stringify(summaryBody),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const request = {
      runId: "run-1",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1 as const,
          compactionId,
          status: "ready" as const,
          summaryRef,
          sourceRefs: summaryBody.sourceRefs,
          summaryHash: summaryRef.contentHash,
          cursor: `offset:${upperWatermark}`,
          upperWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 42,
        },
        summary: summaryBody,
      },
    };
    const committed = await core.commitCompaction(request);
    expect(committed.payload.compactionId).toBe(compactionId);
    expect(projectFukai(await ledger.read(), "run-1", "main").latestCompaction).toEqual(committed);

    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "ready",
      reasons: [],
      compactionId,
      selection: { summary: summaryBody },
    });
    await expect(core.commitCompaction(request)).resolves.toEqual(committed);
  });

  it("rejects a roll-forward base from an older Goal version", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const original = await store.put("original evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: original }));
    const originalWatermark = await ledger.watermark();
    const originalSources = [{ kind: "conversation" as const, ref: original }];
    const originalSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Keep the original decision"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: originalSources,
    };
    const originalSummaryRef = await store.put(
      JSON.stringify(originalSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    await core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef: originalSummaryRef,
          sourceRefs: originalSources,
          summaryHash: originalSummaryRef.contentHash,
          cursor: `offset:${originalWatermark}`,
          upperWatermark: originalWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: originalSummary,
      },
    });

    const revisedGoal = { ...goal, version: 2, statement: "Inspect a different workspace" };
    await ledger.append(command("goal.revised", { goal: revisedGoal }));
    const newEvidence = await store.put("new evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: newEvidence }));
    const revisedWatermark = await ledger.watermark();
    const revisedSources = [
      { kind: "artifact" as const, ref: originalSummaryRef },
      { kind: "conversation" as const, ref: newEvidence },
    ];
    const revisedSummary = {
      schemaVersion: 1 as const,
      goal: revisedGoal,
      decisions: [],
      verifiedResults: ["New evidence exists"],
      openQuestions: [],
      sourceRefs: revisedSources,
    };
    const revisedSummaryRef = await store.put(
      JSON.stringify(revisedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );

    await expect(core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId: rollForwardCompactionId,
      goal: revisedGoal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId: rollForwardCompactionId,
          status: "ready",
          summaryRef: revisedSummaryRef,
          sourceRefs: revisedSources,
          summaryHash: revisedSummaryRef.contentHash,
          cursor: `offset:${revisedWatermark}`,
          upperWatermark: revisedWatermark,
          goalVersion: revisedGoal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: revisedSummary,
      },
    })).rejects.toThrow("compaction-base-goal-version-changed");
  });

  it("requires the latest summary base for same-Goal lineage but permits a revised-Goal reset", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const deferred = await store.put("deferred oldest message", "text/plain");
    const original = await store.put("summarized original message", "text/plain");
    await ledger.append(command("user.message", { messageRef: deferred }));
    await ledger.append(command("assistant.message", { messageRef: original }));
    const firstWatermark = await ledger.watermark();
    const selectionFor = async (options: {
      id: string;
      currentGoal: Goal;
      source: ArtifactRef;
      cursor: number;
      deferredRefs?: ArtifactRef[];
    }) => {
      const sourceRefs = [{ kind: "conversation" as const, ref: options.source }];
      const summary = {
        schemaVersion: 1 as const,
        goal: options.currentGoal,
        decisions: [],
        verifiedResults: [],
        openQuestions: [],
        sourceRefs,
        ...(options.deferredRefs === undefined
          ? {}
          : { deferredConversationRefs: options.deferredRefs }),
      };
      const summaryRef = await store.put(
        JSON.stringify(summary),
        FUKAI_COMPACTION_MEDIA_TYPE,
      );
      return {
        capsule: {
          schemaVersion: 1 as const,
          compactionId: options.id,
          status: "ready" as const,
          summaryRef,
          sourceRefs,
          ...(options.deferredRefs === undefined
            ? {}
            : { deferredConversationRefs: options.deferredRefs }),
          summaryHash: summaryRef.contentHash,
          cursor: `offset:${options.cursor}`,
          upperWatermark: options.cursor,
          goalVersion: options.currentGoal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary,
      };
    };
    const firstSelection = await selectionFor({
      id: compactionId,
      currentGoal: goal,
      source: original,
      cursor: firstWatermark,
      deferredRefs: [deferred],
    });
    await core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection: firstSelection,
    });

    const sameGoalEvidence = await store.put("same Goal evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: sameGoalEvidence }));
    const sameGoalWatermark = await ledger.watermark();
    const standalone = await selectionFor({
      id: staleCompactionId,
      currentGoal: goal,
      source: sameGoalEvidence,
      cursor: sameGoalWatermark,
    });

    await expect(core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId: staleCompactionId,
      goal,
      policyVersion: "policy-v1",
      selection: standalone,
    })).rejects.toThrow("missing-compaction-base");
    expect((await ledger.read()).filter(
      (event) => event.type === "fukai.compaction.committed",
    )).toHaveLength(1);
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "ready",
      selection: { capsule: { deferredConversationRefs: [deferred] } },
    });

    const revisedGoal = { ...goal, version: 2, statement: "Inspect the revised workspace" };
    await ledger.append(command("goal.revised", { goal: revisedGoal }));
    const revisedEvidence = await store.put("revised Goal evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: revisedEvidence }));
    const revisedWatermark = await ledger.watermark();
    const reset = await selectionFor({
      id: rollForwardCompactionId,
      currentGoal: revisedGoal,
      source: revisedEvidence,
      cursor: revisedWatermark,
    });

    await expect(core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId: rollForwardCompactionId,
      goal: revisedGoal,
      policyVersion: "policy-v1",
      selection: reset,
    })).resolves.toMatchObject({
      type: "fukai.compaction.committed",
      payload: { goalVersion: 2, sourceRefs: reset.capsule.sourceRefs },
    });
  });

  it("repairs a stale same-Goal capsule only after its summary disappears", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const delegate = new ContentStoreFukaiSource(store);
    const missing = new Set<string>();
    const source: FukaiSource = {
      hasArtifact: (ref, options) => missing.has(ref.contentHash)
        ? Promise.resolve(false)
        : delegate.hasArtifact(ref, options),
      readConversation: (ref, options) => delegate.readConversation(ref, options),
      readArtifact: (ref, range, options) => missing.has(ref.contentHash)
        ? Promise.resolve(undefined)
        : delegate.readArtifact(ref, range, options),
    };
    const core = new FukaiCore(ledger, source);
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));

    const originalEvidence = await store.put("original evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: originalEvidence }));
    const originalWatermark = await ledger.watermark();
    const originalSources = [{ kind: "conversation" as const, ref: originalEvidence }];
    const originalSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Keep the original evidence"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: originalSources,
    };
    const originalSummaryRef = await store.put(
      JSON.stringify(originalSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    await core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId,
          status: "ready",
          summaryRef: originalSummaryRef,
          sourceRefs: originalSources,
          summaryHash: originalSummaryRef.contentHash,
          cursor: `offset:${originalWatermark}`,
          upperWatermark: originalWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: originalSummary,
      },
    });

    const repairEvidence = await store.put("standalone repair evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: repairEvidence }));
    const repairWatermark = await ledger.watermark();
    const repairSources = [{ kind: "conversation" as const, ref: repairEvidence }];
    const repairSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Rebuild from available evidence"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: repairSources,
    };
    const repairSummaryRef = await store.put(
      JSON.stringify(repairSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const repairRequest = {
      runId: "run-1",
      laneId: "main" as const,
      compactionId: staleCompactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1 as const,
          compactionId: staleCompactionId,
          status: "ready" as const,
          summaryRef: repairSummaryRef,
          sourceRefs: repairSources,
          summaryHash: repairSummaryRef.contentHash,
          cursor: `offset:${repairWatermark}`,
          upperWatermark: repairWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: repairSummary,
      },
    };

    await expect(core.commitCompaction(repairRequest)).rejects.toThrow(
      "missing-compaction-base",
    );

    missing.add(originalSummaryRef.contentHash);
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      compactionId,
      reasons: expect.arrayContaining([expect.stringContaining("summary-invalid")]),
    });

    await expect(core.commitCompaction({
      ...repairRequest,
      repairFromCompactionId: rollForwardCompactionId,
    })).rejects.toThrow("repair source changed before commit");
    await expect(core.commitCompaction({
      ...repairRequest,
      repairFromCompactionId: "invalid-repair-id",
    })).rejects.toThrow("repair source ID is invalid");
    await expect(core.commitCompaction({
      ...repairRequest,
      repairFromCompactionId: compactionId,
    })).resolves.toMatchObject({
      type: "fukai.compaction.committed",
      payload: {
        compactionId: staleCompactionId,
        resetFromCompactionId: compactionId,
        sourceRefs: repairSources,
      },
    });
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "ready",
      reasons: [],
      compactionId: staleCompactionId,
      selection: { summary: repairSummary },
    });

    const rollForwardEvidence = await store.put("post-repair evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: rollForwardEvidence }));
    const rollForwardWatermark = await ledger.watermark();
    const rollForwardSources = [
      { kind: "artifact" as const, ref: repairSummaryRef },
      { kind: "conversation" as const, ref: rollForwardEvidence },
    ];
    const rollForwardSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Continue from the repaired capsule"],
      verifiedResults: ["Post-repair evidence is retained"],
      openQuestions: [],
      sourceRefs: rollForwardSources,
    };
    const rollForwardSummaryRef = await store.put(
      JSON.stringify(rollForwardSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    await expect(core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId: rollForwardCompactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId: rollForwardCompactionId,
          status: "ready",
          summaryRef: rollForwardSummaryRef,
          sourceRefs: rollForwardSources,
          summaryHash: rollForwardSummaryRef.contentHash,
          cursor: `offset:${rollForwardWatermark}`,
          upperWatermark: rollForwardWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 14,
        },
        summary: rollForwardSummary,
      },
    })).resolves.toMatchObject({
      payload: { compactionId: rollForwardCompactionId },
    });
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "ready",
      reasons: [],
      compactionId: rollForwardCompactionId,
    });

    const forgedCompactionId = `fukai-compaction:sha256:${"e".repeat(64)}`;
    const forgedEvidence = await store.put("forged reset evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: forgedEvidence }));
    const forgedWatermark = await ledger.watermark();
    const forgedSources = [{ kind: "conversation" as const, ref: forgedEvidence }];
    const forgedSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Trust a reset with the wrong parent"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: forgedSources,
    };
    const forgedSummaryRef = await store.put(
      JSON.stringify(forgedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "fukai.compaction.committed",
      payload: {
        compactionId: forgedCompactionId,
        attemptId: null,
        summaryRef: forgedSummaryRef,
        sourceRefs: forgedSources,
        resetFromCompactionId: staleCompactionId,
        cursor: `offset:${forgedWatermark}`,
        upperWatermark: forgedWatermark,
        goalVersion: goal.version,
        policyVersion: "policy-v1",
        summaryHash: forgedSummaryRef.contentHash,
        estimatedTokens: 12,
      },
      correlationId: "test:forged-compaction-reset",
      idempotencyKey: "test:forged-compaction-reset",
      visibility: "lane",
    });
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      compactionId: rollForwardCompactionId,
      reasons: expect.arrayContaining([expect.stringContaining(":reset-invalid")]),
    });

    const taintedCompactionId = `fukai-compaction:sha256:${"b".repeat(64)}`;
    const taintedEvidence = await store.put("tainted roll-forward evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: taintedEvidence }));
    const taintedWatermark = await ledger.watermark();
    const taintedSources = [
      { kind: "artifact" as const, ref: forgedSummaryRef },
      { kind: "conversation" as const, ref: taintedEvidence },
    ];
    const taintedSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Continue from the forged reset"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: taintedSources,
    };
    const taintedSummaryRef = await store.put(
      JSON.stringify(taintedSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const taintedRequest = {
      runId: "run-1",
      laneId: "main" as const,
      compactionId: taintedCompactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1 as const,
          compactionId: taintedCompactionId,
          status: "ready" as const,
          summaryRef: taintedSummaryRef,
          sourceRefs: taintedSources,
          summaryHash: taintedSummaryRef.contentHash,
          cursor: `offset:${taintedWatermark}`,
          upperWatermark: taintedWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: taintedSummary,
      },
    };
    await expect(core.commitCompaction(taintedRequest)).rejects.toThrow(
      "compaction-base-not-latest",
    );

    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "fukai.compaction.committed",
      payload: {
        compactionId: taintedCompactionId,
        attemptId: null,
        summaryRef: taintedSummaryRef,
        sourceRefs: taintedSources,
        cursor: `offset:${taintedWatermark}`,
        upperWatermark: taintedWatermark,
        goalVersion: goal.version,
        policyVersion: "policy-v1",
        summaryHash: taintedSummaryRef.contentHash,
        estimatedTokens: 12,
      },
      correlationId: "test:tainted-compaction-roll-forward",
      idempotencyKey: "test:tainted-compaction-roll-forward",
      visibility: "lane",
    });
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      compactionId: rollForwardCompactionId,
      reasons: expect.arrayContaining([
        expect.stringContaining(":reset-invalid"),
        expect.stringContaining(":lineage-invalid"),
      ]),
    });
  });

  it("quarantines a malformed compaction source entry without throwing", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const malformed = {
      eventId: "event-malformed-compaction",
      runId: "run-1",
      laneId: "main",
      globalOffset: 1,
      laneSeq: 1,
      type: "fukai.compaction.committed",
      schemaVersion: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "test:malformed-compaction",
      idempotencyKey: "test:malformed-compaction",
      visibility: "lane",
      contentHash: digest,
      payload: {
        compactionId,
        attemptId: null,
        summaryRef: {
          id: digest,
          contentHash: digest,
          mediaType: FUKAI_COMPACTION_MEDIA_TYPE,
          byteLength: 10,
        },
        sourceRefs: [null],
        cursor: "offset:1",
        upperWatermark: 1,
        goalVersion: 1,
        policyVersion: "policy-v1",
        summaryHash: digest,
        estimatedTokens: 10,
      },
    } as unknown as EventEnvelope<"fukai.compaction.committed">;

    expect(() => compactionIntegrityReasons(malformed)).not.toThrow();
    expect(compactionIntegrityReasons(malformed)).toContain("source-refs-invalid");
    const projection = projectFukai([malformed], "run-1", "main");
    expect(projection.latestCompaction).toBeUndefined();
    expect(projection.invalidCompactions).toEqual([{
        compaction: malformed,
        reasons: expect.arrayContaining(["source-refs-invalid"]),
    }]);
  });

  it("marks a projected compaction stale when its goal or source is no longer usable", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const source = await store.put("verified source", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: source }));
    const upperWatermark = await ledger.watermark();
    const summaryBody = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Keep the goal"],
      verifiedResults: ["Source exists"],
      openQuestions: [],
      sourceRefs: [{ kind: "artifact" as const, ref: source }],
    };
    const summaryRef = await store.put(JSON.stringify(summaryBody), FUKAI_COMPACTION_MEDIA_TYPE);
    await core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId: staleCompactionId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId: staleCompactionId,
          status: "ready",
          summaryRef,
          sourceRefs: summaryBody.sourceRefs,
          summaryHash: summaryRef.contentHash,
          cursor: `offset:${upperWatermark}`,
          upperWatermark,
          goalVersion: 1,
          policyVersion: "policy-v1",
          estimatedTokens: 12,
        },
        summary: summaryBody,
      },
    });
    await ledger.append(command("goal.revised", {
      goal: { ...goal, version: 2, statement: "A new goal" },
    }));
    await expect(core.readCompaction({
      runId: "run-1",
      laneId: "main",
      goalVersion: 2,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      reasons: expect.arrayContaining(["goal-version-changed"]),
    });
  });

  it("serializes checkpoint monotonicity across FukaiCore instances sharing one Ledger", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const first = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    const second = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("lane.status", { status: "running" }));
    const upperWatermark = await ledger.watermark();
    const base = {
      runId: "run-1",
      laneId: "main" as const,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [] as ArtifactRef[],
      policyVersion: "policy-v1",
    };

    const results = await Promise.allSettled([
      first.commitCheckpoint({ ...base, cursor: `offset:${upperWatermark}` }),
      second.commitCheckpoint({ ...base, cursor: "offset:1" }),
    ]);

    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    if (results[1]!.status === "rejected") {
      expect(results[1]!.reason).toBeInstanceOf(FukaiStaleError);
    }
    expect((await ledger.read({ runId: "run-1" })).filter(
      (event) => event.type === "fukai.checkpoint.committed",
    )).toHaveLength(1);
  });

  it("invalidates a later checkpoint that rolls back cursor or watermark", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const upperWatermark = await ledger.watermark();
    const valid = await core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [],
      policyVersion: "policy-v1",
    });
    const rollbackState = {
      cursor: "offset:0",
      upperWatermark: 0,
      goalVersion: 1,
      stateRefs: [],
      policyVersion: "policy-v1",
    };
    const rollback = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "fukai.checkpoint.committed",
      payload: { ...rollbackState, stateHash: sha256(stableJson(rollbackState)) },
      correlationId: "test:rollback",
      idempotencyKey: "test:rollback",
      visibility: "lane",
    });

    const projected = projectFukai(await ledger.read(), "run-1", "main");
    expect(projected.latestCheckpoint?.eventId).toBe(valid.eventId);
    expect(projected.invalidCheckpoints).toContainEqual({
      checkpoint: rollback,
      reasons: ["cursor-regressed", "watermark-regressed"],
    });
  });

  it("revalidates checkpoint watermark and lane-visible state references on read", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("private", "text/plain");
    await ledger.append({
      ...command("assistant.message", { messageRef: ref }, "teto"),
      visibility: "lane",
    });
    const state = {
      cursor: "offset:999",
      upperWatermark: 999,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    };
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "fukai.checkpoint.committed",
      payload: { ...state, stateHash: sha256(stableJson(state)) },
      correlationId: "test:future",
      idempotencyKey: "test:future",
      visibility: "lane",
    });

    await expect(core.readCheckpoint({
      runId: "run-1",
      laneId: "main",
      goalVersion: 1,
      policyVersion: "policy-v1",
    })).resolves.toMatchObject({
      status: "stale",
      reasons: expect.arrayContaining([
        expect.stringMatching(/^checkpoint-future-watermark:999:\d+$/),
        `missing-state-ref-reference:${ref.id}`,
      ]),
      checkpoint: { payload: { stateRefs: [ref] } },
    });
  });

  it("allows an aborted checkpoint waiter to leave the shared lock usable", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const delegate = new ContentStoreFukaiSource(store);
    let releaseRead!: () => void;
    let readStarted!: () => void;
    let hasCalls = 0;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    const source: FukaiSource = {
      hasArtifact: async (ref, options) => {
        hasCalls += 1;
        readStarted();
        await blocked;
        return delegate.hasArtifact(ref, options);
      },
      readConversation: (ref, options) => delegate.readConversation(ref, options),
      readArtifact: (ref, range, options) => delegate.readArtifact(ref, range, options),
    };
    const first = new FukaiCore(ledger, source);
    const second = new FukaiCore(ledger, source);
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const ref = await store.put("state", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: ref }));
    const upperWatermark = await ledger.watermark();
    const base = {
      runId: "run-1",
      laneId: "main" as const,
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: [ref],
      policyVersion: "policy-v1",
    };
    const running = first.commitCheckpoint(base);
    await started;
    const controller = new AbortController();
    const waiting = second.commitCheckpoint({ ...base, signal: controller.signal });
    controller.abort(new Error("cancel waiter"));
    await expect(waiting).rejects.toThrow("cancel waiter");
    const following = second.commitCheckpoint(base);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasCalls).toBe(1);
    releaseRead();
    await running;
    await expect(following).resolves.toMatchObject({ type: "fukai.checkpoint.committed" });
  });

  it("rejects unbounded Fukai identifiers, filters, budgets, and state refs", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const upperWatermark = await ledger.watermark();
    const budget = { maxEvents: 1, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 };
    const query = (extra: Record<string, unknown>) => core.queryEvents({
      runId: "run-1",
      laneId: "main",
      reason: "bounded",
      upperWatermark,
      budget,
      ...extra,
    } as never);
    await expect(query({ queryId: "q".repeat(257) })).rejects.toThrow(/queryId/);
    await expect(query({ reason: "r".repeat(1_025) })).rejects.toThrow(/reason/);
    await expect(query({ filters: { eventIds: Array.from({ length: 129 }, (_, i) => String(i)) } })).rejects.toThrow(/exceeds/);
    await expect(query({ budget: { ...budget, maxEvents: 100_001 } })).rejects.toThrow(/maxEvents/);
    const refs = Array.from({ length: 129 }, () => ({
      id: "sha256:" + "a".repeat(64),
      contentHash: "sha256:" + "a".repeat(64),
      mediaType: "text/plain",
      byteLength: 1,
    }));
    await expect(core.commitCheckpoint({
      runId: "run-1",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: 1,
      stateRefs: refs,
      policyVersion: "policy-v1",
    })).rejects.toThrow(/stateRefs/);
  });
});

function command<K extends EventType>(
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId = "main",
): AppendEvent<K> {
  return {
    runId: "run-1",
    laneId,
    type,
    payload,
    correlationId: `test:${type}`,
    idempotencyKey: `${type}:${laneId}:${JSON.stringify(payload)}`,
  };
}
