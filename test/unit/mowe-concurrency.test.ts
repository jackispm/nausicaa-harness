import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MoweCatalog, MoweExecutor } from "../../src/mowe/index.js";
import { toolResultByteLength } from "../../src/mowe/result-projector.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";

type Deferred = ReturnType<typeof deferred<void>>;

function tool(
  name: string,
  execute: AgentTool["execute"],
  metadata: Parameters<MoweCatalog["register"]>[1],
): { tool: AgentTool; metadata: typeof metadata } {
  return {
    tool: {
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      execute,
    },
    metadata,
  };
}

describe("Mowe concurrency admission", () => {
  it("retains completed calls immediately while preserving request order", async () => {
    const releaseSlow = deferred();
    const fastFinished = deferred();
    const store = new MemoryContentAddressedStore();
    let artifactBytes = 0;
    let artifactPuts = 0;
    const slow = tool(
      "slow_result",
      async () => {
        await releaseSlow.promise;
        return { content: "slow-value", isError: false };
      },
      { effect: "read", concurrencySafe: true, maxConcurrency: 2 },
    );
    const fast = tool(
      "fast_result",
      async () => {
        fastFinished.resolve();
        return { content: "0123456789", isError: false };
      },
      { effect: "read", concurrencySafe: true, maxConcurrency: 2 },
    );
    const catalog = new MoweCatalog();
    catalog.register(slow.tool, slow.metadata);
    catalog.register(fast.tool, fast.metadata);
    const execution = new MoweExecutor({ catalog, maxConcurrency: 2 }).execute({
      runId: "completion-order",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 10 },
      artifactStore: {
        put: async (data, mediaType) => {
          artifactPuts += 1;
          artifactBytes += typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data.byteLength;
          return store.put(data, mediaType);
        },
      },
      calls: [
        { id: "slow", name: "slow_result", arguments: {} },
        {
          id: "fast",
          name: "fast_result",
          arguments: {},
          projection: { mode: "artifact" },
        },
      ],
    });

    try {
      await fastFinished.promise;
      await eventually(() => expect(artifactPuts).toBe(1));
      expect(artifactBytes).toBe(10);
    } finally {
      releaseSlow.resolve();
    }

    const response = await execution;
    expect(response.results.map((result) => result.callId)).toEqual(["slow", "fast"]);
    expect(response.results[0]?.result.content).toBe("");
    expect(response.results[1]).toMatchObject({
      callId: "fast",
      result: { content: "" },
      projection: { mode: "artifact", byteLength: 10, truncated: false },
    });
    const returnedBytes = response.results.reduce((total, result) => {
      return total
        + toolResultByteLength(result.result)
        + Buffer.byteLength(result.error ?? "", "utf8")
        + Buffer.byteLength(result.projection?.content ?? "", "utf8");
    }, 0);
    expect(artifactBytes + returnedBytes).toBeLessThanOrEqual(10);
  });

  it("reserves output before awaiting artifact storage", async () => {
    const artifactPutStarted = deferred();
    const releaseArtifactPut = deferred();
    const store = new MemoryContentAddressedStore();
    let artifactPuts = 0;
    let thirdStarted = false;
    const catalog = new MoweCatalog();
    const first = tool(
      "first_artifact",
      async () => ({ content: "0123456789", isError: false }),
      { effect: "read", concurrencySafe: true, maxConcurrency: 2 },
    );
    const second = tool(
      "second_artifact",
      async () => {
        await artifactPutStarted.promise;
        return { content: "abcdefghij", isError: false };
      },
      { effect: "read", concurrencySafe: true, maxConcurrency: 2 },
    );
    const third = tool(
      "after_reservation",
      async () => {
        thirdStarted = true;
        return { content: "third", isError: false };
      },
      { effect: "read", concurrencySafe: true, maxConcurrency: 2 },
    );
    catalog.register(first.tool, first.metadata);
    catalog.register(second.tool, second.metadata);
    catalog.register(third.tool, third.metadata);
    const execution = new MoweExecutor({ catalog, maxConcurrency: 2 }).execute({
      runId: "synchronous-reservation",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 10 },
      artifactStore: {
        put: async (data, mediaType) => {
          artifactPuts += 1;
          artifactPutStarted.resolve();
          await releaseArtifactPut.promise;
          return store.put(data, mediaType);
        },
      },
      calls: [
        {
          id: "first",
          name: "first_artifact",
          arguments: {},
          projection: { mode: "artifact" },
        },
        {
          id: "second",
          name: "second_artifact",
          arguments: {},
          projection: { mode: "artifact" },
        },
        { id: "third", name: "after_reservation", arguments: {} },
      ],
    });

    try {
      await eventually(() => expect(thirdStarted).toBe(true));
      expect(artifactPuts).toBe(1);
    } finally {
      releaseArtifactPut.resolve();
    }

    const response = await execution;
    expect(response.results.map((result) => result.callId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(response.results[0]?.projection?.artifactRef).toBeDefined();
    expect(response.results[1]?.projection).toBeUndefined();
    expect(response.results[1]?.result.content).toBe("");
    expect(response.results[2]?.result.content).toBe("");
  });

  it("serializes unsafe calls without reducing independent read concurrency", async () => {
    const releaseUnsafe = deferred();
    const releaseRead = deferred();
    let unsafeActive = 0;
    let unsafeMaximum = 0;
    let readActive = 0;
    let readMaximum = 0;
    const unsafe = tool(
      "mutate",
      async () => {
        unsafeActive += 1;
        unsafeMaximum = Math.max(unsafeMaximum, unsafeActive);
        await releaseUnsafe.promise;
        unsafeActive -= 1;
        return { content: "mutated", isError: false };
      },
      { effect: "write", concurrencySafe: false, supportsBatch: false },
    );
    const read = tool(
      "inspect",
      async () => {
        readActive += 1;
        readMaximum = Math.max(readMaximum, readActive);
        await releaseRead.promise;
        readActive -= 1;
        return { content: "read", isError: false };
      },
      { effect: "read", concurrencySafe: true, supportsBatch: true, maxConcurrency: 2 },
    );
    const catalog = new MoweCatalog();
    catalog.register(unsafe.tool, unsafe.metadata);
    catalog.register(read.tool, read.metadata);
    const execution = new MoweExecutor({ catalog, maxConcurrency: 3 }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "mutate-1", name: "mutate", arguments: {} },
        { id: "mutate-2", name: "mutate", arguments: {} },
        { id: "inspect-1", name: "inspect", arguments: {} },
        { id: "inspect-2", name: "inspect", arguments: {} },
      ],
    });

    await eventually(() => expect(unsafeActive).toBe(1));
    expect(readMaximum).toBe(2);
    expect(unsafeMaximum).toBe(1);
    releaseRead.resolve();
    releaseUnsafe.resolve();
    const response = await execution;
    expect(response.results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(unsafeMaximum).toBe(1);
  });

  it("shares a concurrency slot across whitespace-normalized tool aliases", async () => {
    const release = deferred();
    let active = 0;
    let maximum = 0;
    const unsafe = tool(
      "mutate",
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await release.promise;
        active -= 1;
        return { content: "mutated", isError: false };
      },
      { effect: "external", concurrencySafe: false, supportsBatch: false },
    );
    const catalog = new MoweCatalog();
    catalog.register(unsafe.tool, unsafe.metadata);
    const execution = new MoweExecutor({ catalog, maxConcurrency: 2 }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "canonical", name: "mutate", arguments: {} },
        { id: "legacy-alias", name: " mutate ", arguments: {} },
      ],
    });

    await eventually(() => expect(active).toBe(1));
    expect(maximum).toBe(1);
    release.resolve();
    await expect(execution).resolves.toMatchObject({
      results: [{ status: "succeeded" }, { status: "succeeded" }],
    });
    expect(maximum).toBe(1);
  });

  it("serializes distinct workspace writes while reads continue in the same batch", async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const releaseRead = deferred();
    const events: string[] = [];
    let writesActive = 0;
    let writesMaximum = 0;
    let readsActive = 0;
    let readsMaximum = 0;

    const write = (name: string, release: Deferred): { tool: AgentTool; metadata: Parameters<MoweCatalog["register"]>[1] } => ({
      tool: {
        definition: {
          name,
          description: name,
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          events.push(`start:${name}`);
          writesActive += 1;
          writesMaximum = Math.max(writesMaximum, writesActive);
          await release.promise;
          writesActive -= 1;
          events.push(`end:${name}`);
          return { content: name, isError: false };
        },
      },
      metadata: { effect: "write", scope: "workspace", concurrencySafe: false, supportsBatch: false },
    });
    const read = tool(
      "inspect",
      async () => {
        events.push("start:inspect");
        readsActive += 1;
        readsMaximum = Math.max(readsMaximum, readsActive);
        await releaseRead.promise;
        readsActive -= 1;
        events.push("end:inspect");
        return { content: "read", isError: false };
      },
      { effect: "read", concurrencySafe: true, supportsBatch: true, maxConcurrency: 2 },
    );
    const catalog = new MoweCatalog();
    const first = write("write_file", releaseFirst);
    const second = write("edit", releaseSecond);
    catalog.register(first.tool, first.metadata);
    catalog.register(second.tool, second.metadata);
    catalog.register(read.tool, read.metadata);

    const execution = new MoweExecutor({ catalog, maxConcurrency: 3 }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp/mowe-lock-batch",
      calls: [
        { id: "first", name: "write_file", arguments: {} },
        { id: "second", name: "edit", arguments: {} },
        { id: "read", name: "inspect", arguments: {} },
      ],
    });

    await eventually(() => expect(events).toContain("start:write_file"));
    await eventually(() => expect(events).toContain("start:inspect"));
    expect(events).not.toContain("start:edit");
    expect(writesMaximum).toBe(1);
    expect(readsMaximum).toBe(1);

    releaseFirst.resolve();
    await eventually(() => expect(events).toContain("start:edit"));
    expect(writesMaximum).toBe(1);
    releaseRead.resolve();
    releaseSecond.resolve();
    const response = await execution;
    expect(response.results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("shares the workspace write mutex across concurrent execute batches", async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const events: string[] = [];
    let writesActive = 0;
    let writesMaximum = 0;
    const createWrite = (name: string, release: Deferred): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        events.push(`start:${name}`);
        writesActive += 1;
        writesMaximum = Math.max(writesMaximum, writesActive);
        await release.promise;
        writesActive -= 1;
        events.push(`end:${name}`);
        return { content: name, isError: false };
      },
    });
    const catalog = new MoweCatalog();
    catalog.register(createWrite("batch_one_write", releaseFirst), {
      effect: "write",
      scope: "workspace",
      concurrencySafe: false,
      supportsBatch: false,
    });
    catalog.register(createWrite("batch_two_write", releaseSecond), {
      effect: "write",
      scope: "workspace",
      concurrencySafe: false,
      supportsBatch: false,
    });
    const firstExecutor = new MoweExecutor({ catalog, maxConcurrency: 2 });
    const secondExecutor = new MoweExecutor({ catalog, maxConcurrency: 2 });
    const request = {
      workspace: "/tmp/mowe-lock-shared",
      calls: [] as const,
    };
    const firstExecution = firstExecutor.execute({
      ...request,
      runId: "run-one",
      laneId: "main",
      calls: [{ id: "one", name: "batch_one_write", arguments: {} }],
    });
    await eventually(() => expect(events).toContain("start:batch_one_write"));
    const secondExecution = secondExecutor.execute({
      ...request,
      runId: "run-two",
      laneId: "main",
      calls: [{ id: "two", name: "batch_two_write", arguments: {} }],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(events).not.toContain("start:batch_two_write");
    expect(writesMaximum).toBe(1);

    releaseFirst.resolve();
    await eventually(() => expect(events).toContain("start:batch_two_write"));
    releaseSecond.resolve();
    await expect(firstExecution).resolves.toMatchObject({ status: "succeeded" });
    await expect(secondExecution).resolves.toMatchObject({ status: "succeeded" });
    expect(writesMaximum).toBe(1);
  });

  it("shares the workspace write mutex across canonical aliases with a missing leaf", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-mowe-alias-"));
    const canonicalParent = join(root, "canonical");
    const aliasParent = join(root, "alias");
    await mkdir(canonicalParent);
    await symlink(canonicalParent, aliasParent, "dir");
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const events: string[] = [];
    let active = 0;
    let maximum = 0;
    const createWrite = (name: string, release: Deferred): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        events.push(`start:${name}`);
        active += 1;
        maximum = Math.max(maximum, active);
        await release.promise;
        active -= 1;
        return { content: name, isError: false };
      },
    });
    const catalog = new MoweCatalog();
    catalog.register(createWrite("canonical_write", releaseFirst), {
      effect: "write",
      scope: "workspace",
      concurrencySafe: false,
    });
    catalog.register(createWrite("alias_write", releaseSecond), {
      effect: "write",
      scope: "workspace",
      concurrencySafe: false,
    });

    try {
      const first = new MoweExecutor({ catalog }).execute({
        runId: "canonical-run",
        laneId: "main",
        workspace: join(canonicalParent, "not-created-yet"),
        calls: [{ id: "canonical", name: "canonical_write", arguments: {} }],
      });
      await eventually(() => expect(events).toContain("start:canonical_write"));
      const second = new MoweExecutor({ catalog }).execute({
        runId: "alias-run",
        laneId: "main",
        workspace: join(aliasParent, "not-created-yet"),
        calls: [{ id: "alias", name: "alias_write", arguments: {} }],
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(events).not.toContain("start:alias_write");
      expect(maximum).toBe(1);
      releaseFirst.resolve();
      await eventually(() => expect(events).toContain("start:alias_write"));
      releaseSecond.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(maximum).toBe(1);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases a queued workspace write when its signal is cancelled", async () => {
    const releaseFirst = deferred();
    const controller = new AbortController();
    const events: string[] = [];
    const catalog = new MoweCatalog();
    const first: AgentTool = {
      definition: {
        name: "first_write",
        description: "first_write",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        events.push("start:first_write");
        await releaseFirst.promise;
        events.push("end:first_write");
        return { content: "first", isError: false };
      },
    };
    const second: AgentTool = {
      definition: {
        name: "second_write",
        description: "second_write",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        events.push("start:second_write");
        return { content: "second", isError: false };
      },
    };
    catalog.register(first, { effect: "write", scope: "workspace", concurrencySafe: false });
    catalog.register(second, { effect: "write", scope: "workspace", concurrencySafe: false });
    const executor = new MoweExecutor({ catalog, maxConcurrency: 2 });
    const firstExecution = executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp/mowe-lock-cancel",
      calls: [{ id: "first", name: "first_write", arguments: {} }],
    });
    await eventually(() => expect(events).toContain("start:first_write"));
    const secondExecution = executor.execute({
      runId: "run-2",
      laneId: "main",
      workspace: "/tmp/mowe-lock-cancel",
      signal: controller.signal,
      calls: [{ id: "second", name: "second_write", arguments: {} }],
    });
    controller.abort(new Error("cancel queued write"));
    await expect(secondExecution).resolves.toMatchObject({
      status: "cancelled",
      results: [{ status: "cancelled" }],
    });
    expect(events).not.toContain("start:second_write");
    releaseFirst.resolve();
    await expect(firstExecution).resolves.toMatchObject({ status: "succeeded" });
  });
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((mark) => {
    resolve = mark;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}
