import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, AnyEvent, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  buildWorkspaceRunTree,
  flattenWorkspaceRunTree,
  listWorkspaceRunTree,
  listWorkspaceRuns,
  SessionController,
} from "../../src/runtime/index.js";
import { resolveRunPolicy } from "../../src/runtime/run-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionController Run fork", () => {
  it("copies verified Main history while keeping parent and child effects isolated", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const model = new ScriptedModel([
      response("parent tool", [{ id: "parent-call", name: "noop", arguments: {} }], "toolUse"),
      response("parent answer"),
      response("child tool", [{ id: "child-call", name: "noop", arguments: {} }], "toolUse"),
      response("child answer"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 3, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: model,
      tools: [noopTool],
      createRunId: () => "parent-run",
    });
    const observed: AnyEvent[] = [];
    session.subscribe((runtimeEvent) => {
      if (runtimeEvent.kind === "event") observed.push(runtimeEvent.event);
    });

    await session.submit({ inputId: "parent-input", text: "Inspect the parent" });
    await session.waitForIdle();
    const parentBefore = observed.filter((event) => event.runId === "parent-run");
    const parentDigest = parentBefore.map((event) => event.contentHash);
    expect(parentBefore.some((event) => event.type === "checkpoint.committed")).toBe(true);

    const fork = await session.forkRun({ runId: "child-run" });
    expect(fork).toMatchObject({
      runId: "child-run",
      parentRunId: "parent-run",
      parentCheckpoint: { watermark: expect.any(Number), checksum: expect.stringMatching(/^sha256:/u) },
    });
    expect(session.snapshot().runId).toBe("child-run");
    expect((await session.transcript()).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    await session.submit({ inputId: "child-input", text: "Continue independently" });
    await session.waitForIdle();
    const childTranscript = await session.transcript();
    expect(childTranscript.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(childTranscript.at(-1)).toMatchObject({ role: "assistant", content: "child answer" });

    await session.close();
    const parentAfter = observed.filter((event) => event.runId === "parent-run");
    const childEvents = await readEvents(dataDir, "child-run");
    expect(parentAfter.map((event) => event.contentHash)).toEqual(parentDigest);
    expect(childEvents.every((event) => event.runId === "child-run")).toBe(true);
    expect(childEvents.find((event) => event.type === "run.forked")).toMatchObject({
      payload: { parentRunId: "parent-run", parentCheckpoint: fork.parentCheckpoint },
    });

    const parentToolOperations = new Set(parentBefore.flatMap((event) => (
      event.type === "tool.requested" ? [event.payload.operationId] : []
    )));
    const childToolOperations = childEvents.flatMap((event) => (
      event.type === "tool.requested" ? [event.payload.operationId] : []
    ));
    expect(new Set(childToolOperations).size).toBeGreaterThan(parentToolOperations.size);
    expect(childToolOperations.some((operationId) => !parentToolOperations.has(operationId))).toBe(true);

    const runs = await listWorkspaceRuns(dataDir, root);
    expect(runs.find((run) => run.runId === "child-run")).toMatchObject({
      parentRunId: "parent-run",
      parentCheckpoint: fork.parentCheckpoint,
    });
  });

  it("rejects a parent without a committed checkpoint", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const runId = "no-checkpoint";
    const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
    const policy = resolveRunPolicy({
      maxMainStepsPerActivation: 1,
      maxModelTokens: 10_000,
      tetoEnabled: false,
    });
    await ledger.append({
      runId,
      laneId: "main",
      type: "run.created",
      payload: { workspace: root, policy },
      correlationId: `run:${runId}`,
      idempotencyKey: "run:created",
      visibility: "run",
    });
    await ledger.append({
      runId,
      laneId: "main",
      type: "lane.registered",
      payload: { kind: "main" },
      correlationId: `run:${runId}`,
      idempotencyKey: "lane:main:registered",
      visibility: "run",
    });
    await ledger.close();

    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      runId,
    }, { mainModel: new ScriptedModel([]) });
    await expect(session.forkRun({ runId: "child-no-checkpoint" }))
      .rejects.toThrow("committed parent checkpoint");
    await session.close();
  });

  it("forks from an explicitly requested earlier committed checkpoint", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const model = new ScriptedModel([
      response("first answer"),
      response("second answer"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted:first",
      policy: { maxMainStepsPerActivation: 2, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "history-parent-run",
    });
    const observed: AnyEvent[] = [];
    session.subscribe((runtimeEvent) => {
      if (runtimeEvent.kind === "event") observed.push(runtimeEvent.event);
    });

    await session.submit({ inputId: "history-first-input", text: "first question" });
    await session.waitForIdle();
    const firstCheckpoint = observed.find((event): event is Extract<AnyEvent, {
      type: "checkpoint.committed";
    }> => event.type === "checkpoint.committed");
    if (firstCheckpoint === undefined) throw new Error("Missing first checkpoint");

    // The later model selection must not leak into a fork from this checkpoint.
    await session.selectModel("scripted:second");
    await session.submit({ inputId: "history-second-input", text: "second question" });
    await session.waitForIdle();
    await expect(session.forkRun({
      runId: "history-child-run",
      checkpoint: {
        watermark: firstCheckpoint.payload.watermark,
        checksum: firstCheckpoint.payload.checksum,
      },
    })).resolves.toMatchObject({
      runId: "history-child-run",
      parentRunId: "history-parent-run",
      parentCheckpoint: firstCheckpoint.payload,
    });
    await expect(session.transcript()).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "first question" }),
      expect.objectContaining({ role: "assistant", content: "first answer" }),
    ]);
    expect(session.snapshot().model).toBe("scripted:first");
    await session.close();
  });

  it("projects multiple descendants and historical checkpoints as one navigable tree", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("parent answer")]),
      createRunId: () => "tree-parent-run",
    });
    const observed: AnyEvent[] = [];
    session.subscribe((runtimeEvent) => {
      if (runtimeEvent.kind === "event") observed.push(runtimeEvent.event);
    });
    await session.submit({ inputId: "tree-parent-input", text: "Build the parent" });
    await session.waitForIdle();
    const checkpoint = observed.find((event): event is Extract<AnyEvent, {
      type: "checkpoint.committed";
    }> => event.type === "checkpoint.committed");
    if (checkpoint === undefined) throw new Error("Missing parent checkpoint");

    await session.forkRun({
      runId: "tree-child-a",
      checkpoint: checkpoint.payload,
    });
    await session.attachRun("tree-parent-run");
    await session.forkRun({
      runId: "tree-child-b",
      checkpoint: checkpoint.payload,
    });

    const tree = await listWorkspaceRunTree(dataDir, root);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.run.runId).toBe("tree-parent-run");
    expect(tree[0]?.children.map((node) => node.run.runId)).toEqual([
      "tree-child-b",
      "tree-child-a",
    ]);
    expect(tree[0]?.children.every((node) => (
      node.run.parentCheckpoint?.watermark === checkpoint.payload.watermark
      && node.run.branchSummary?.includes(`checkpoint ${checkpoint.payload.watermark}`)
    ))).toBe(true);
    expect(tree[0]?.run.checkpoints).toEqual([checkpoint.payload]);
    const rows = flattenWorkspaceRunTree(tree);
    expect(rows.map((row) => [row.run.runId, row.depth])).toEqual([
      ["tree-parent-run", 0],
      ["tree-child-b", 1],
      ["tree-child-a", 1],
    ]);
    await session.close();
  });

  it("hides a structurally valid but checksum-corrupted checkpoint from navigation", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const session = await SessionController.open({
      workspace: root,
      dataDir,
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("answer")]),
      createRunId: () => "checkpoint-parent",
    });

    await session.submit({ inputId: "checkpoint-input", text: "Create a checkpoint" });
    await session.waitForIdle();
    await session.close();

    const ledger = await JsonlLedger.open(join(
      dataDir,
      "runs",
      "checkpoint-parent",
      "ledger.jsonl",
    ));
    const events = await ledger.read({ runId: "checkpoint-parent" });
    const latest = events.at(-1);
    if (latest === undefined) throw new Error("Missing checkpoint source events");
    await ledger.append({
      runId: "checkpoint-parent",
      laneId: "main",
      type: "checkpoint.committed",
      payload: {
        watermark: latest.globalOffset,
        checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      correlationId: "checkpoint:corrupted",
      idempotencyKey: "checkpoint:corrupted",
      visibility: "run",
    });
    await ledger.close();

    const run = (await listWorkspaceRuns(dataDir, root)).find(
      (candidate) => candidate.runId === "checkpoint-parent",
    );
    expect(run?.checkpoints?.some((checkpoint) => (
      checkpoint.checksum
        === "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    )) ?? false).toBe(false);
    expect((await listWorkspaceRunTree(dataDir, root)).map((node) => node.run.runId)).toEqual([
      "checkpoint-parent",
    ]);
  });

  it("keeps orphaned and cyclic lineage visible as roots", () => {
    const summary = (runId: string, parentRunId?: string) => ({
      runId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      goal: runId,
      status: "ready" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const tree = buildWorkspaceRunTree([
      summary("root"),
      summary("orphan", "missing"),
      summary("cycle-a", "cycle-b"),
      summary("cycle-b", "cycle-a"),
    ]);
    expect(tree.map((node) => node.run.runId)).toEqual([
      "root",
      "orphan",
      "cycle-b",
      "cycle-a",
    ]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });
});

const noopTool: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

function response(
  content: string,
  toolCalls: ModelResponse["toolCalls"] = [],
  stopReason: ModelResponse["stopReason"] = "stop",
): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

async function readEvents(dataDir: string, runId: string): Promise<AnyEvent[]> {
  const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
  try {
    return await ledger.read({ runId });
  } finally {
    await ledger.close();
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-fork-"));
  roots.push(root);
  return root;
}
