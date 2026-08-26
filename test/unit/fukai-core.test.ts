import { describe, expect, it } from "vitest";

import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { ArtifactRef, Goal, RunPolicy } from "../../src/domain/types.js";
import {
  FukaiCore,
  FukaiStaleError,
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
