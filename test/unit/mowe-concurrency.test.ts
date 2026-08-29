import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MoweCatalog, MoweExecutor } from "../../src/mowe/index.js";

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
