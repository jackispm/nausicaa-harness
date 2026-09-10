import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileProcessJobRegistry,
  ProcessJobManager,
  createProcessJobTools,
} from "../../src/tools/process-jobs.js";

const workspaces: string[] = [];
const managers: ProcessJobManager[] = [];
const waitForTestRelease = "while [ ! -f .process-release ]; do sleep 0.02; done";

afterEach(async () => {
  const closing = managers.splice(0);
  for (const manager of closing) manager.close();
  await Promise.all(closing.map((manager) => manager.flush().catch(() => undefined)));
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, {
    recursive: true,
    force: true,
  })));
});

describe("process jobs", () => {
  it("starts, observes, reads output, and reaches a terminal state", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager({ defaultTimeoutSeconds: 2 });
    managers.push(manager);
    const tools = createProcessJobTools(manager);
    const context = toolContext(workspace);

    const started = parse(await tools[0]!.execute({
      command: "printf ready; sleep 0.05",
    }, context));
    expect(started.id).toEqual(expect.any(String));
    expect(started.runId).toBe("run-1");
    expect(started.state).toBe("running");

    await eventually(async () => {
      const output = parse(await tools[2]!.execute({
        jobId: started.id,
        stream: "stdout",
      }, context));
      expect(output.stdout.content).toContain("ready");
    });

    await eventually(async () => {
      const status = parse(await tools[1]!.execute({ jobId: started.id }, context));
      expect(status.state).toBe("succeeded");
      expect(status.exitCode).toBe(0);
    });
  });

  it("enforces per-stream output bounds and records the reason", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager({
      defaultTimeoutSeconds: 2,
      defaultMaxOutputBytes: 64,
      maxOutputBytes: 64,
    });
    managers.push(manager);
    const tool = createProcessJobTools(manager)[0]!;
    const context = toolContext(workspace);
    const started = parse(await tool.execute({
      command: "node -e 'process.stdout.write(\"x\".repeat(500)); setTimeout(()=>{},500)'",
      maxOutputBytes: 64,
    }, context));

    await eventually(async () => {
      const status = await manager.status(started.id, context);
      expect(status.state).toBe("output_limited");
      expect(status.terminationReason).toBe("output_limited");
      expect(status.stdout.totalBytes).toBeGreaterThan(64);
      expect(Buffer.byteLength(status.stdout.content, "utf8")).toBeLessThanOrEqual(50 * 1024);
    });
  });

  it("cancels a running process through the caller AbortSignal", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager({ defaultTimeoutSeconds: 2 });
    managers.push(manager);
    const controller = new AbortController();
    const context = toolContext(workspace, controller.signal);
    const started = await manager.start({ command: "sleep 2" }, context);

    controller.abort(new Error("stop"));
    await eventually(async () => {
      const status = await manager.status(started.id, toolContext(workspace));
      expect(status.state).toBe("aborted");
      expect(status.terminationReason).toBe("aborted");
    });
  });

  it("times out jobs and keeps lifecycle operations run/workspace scoped", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager({
      defaultTimeoutSeconds: 0.03,
      maxTimeoutSeconds: 0.1,
    });
    managers.push(manager);
    const context = toolContext(workspace);
    const started = await manager.start({ command: "sleep 2" }, context);

    await eventually(async () => {
      const status = await manager.status(started.id, context);
      expect(status.state).toBe("timed_out");
      expect(status.terminationReason).toBe("timed_out");
    });
    await expect(manager.status(started.id, toolContext(workspace, undefined, "other-run")))
      .rejects.toThrow(/outside the current run/i);
  });

  it("reports unknown jobs and rejects malformed lifecycle input", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager();
    managers.push(manager);
    const tools = createProcessJobTools(manager);
    const context = toolContext(workspace);

    const unknown = await tools[1]!.execute({ jobId: "missing" }, context);
    expect(unknown.isError).toBe(true);
    expect(parse(unknown).error).toMatch(/unknown process job/i);
    const malformed = await tools[0]!.execute({ command: "x", timeout: 0 }, context);
    expect(malformed.isError).toBe(true);
    expect(parse(malformed).error).toMatch(/timeout/i);
  });

  it("persists start and terminal snapshots and exposes them after reopen", async () => {
    const workspace = await temporaryDirectory();
    const registryPath = path.join(workspace, "state", "process-jobs.json");
    const registry = await FileProcessJobRegistry.open(registryPath);
    const manager = new ProcessJobManager({
      registry,
      defaultTimeoutSeconds: 10,
    });
    managers.push(manager);
    const context = toolContext(workspace);
    const started = await manager.start({ command: `printf persisted; ${waitForTestRelease}` }, context);
    await manager.flush();

    const runningEntries = await registry.load();
    expect(runningEntries).toHaveLength(1);
    expect(runningEntries[0]?.snapshot).toMatchObject({
      id: started.id,
      runId: "run-1",
      state: "running",
    });

    await writeFile(path.join(workspace, ".process-release"), "");
    await eventually(async () => {
      expect((await manager.status(started.id, context)).state).toBe("succeeded");
    });
    await manager.flush();

    const reopened = new ProcessJobManager({
      registry: await FileProcessJobRegistry.open(registryPath),
    });
    managers.push(reopened);
    const persisted = await reopened.listPersisted();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      status: "terminal",
      persisted: true,
      snapshot: { id: started.id, state: "succeeded", exitCode: 0 },
    });
    await expect(reopened.status(started.id, context)).resolves.toMatchObject({
      id: started.id,
      state: "succeeded",
    });
    await expect(reopened.output({ jobId: started.id }, context))
      .rejects.toThrow(/terminal metadata/i);
  });

  it("marks persisted running jobs orphaned without restoring an OS process", async () => {
    const workspace = await temporaryDirectory();
    const registryPath = path.join(workspace, "process-jobs.json");
    const manager = new ProcessJobManager({
      registry: await FileProcessJobRegistry.open(registryPath),
      defaultTimeoutSeconds: 10,
    });
    managers.push(manager);
    const context = toolContext(workspace);
    const started = await manager.start({ command: waitForTestRelease }, context);
    await manager.flush();

    const reopened = new ProcessJobManager({
      registry: await FileProcessJobRegistry.open(registryPath),
    });
    managers.push(reopened);
    const entries = await reopened.list(context);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "orphaned",
        persisted: true,
        snapshot: expect.objectContaining({ id: started.id, state: "running" }),
      }),
    ]));
    await expect(reopened.status(started.id, context))
      .rejects.toThrow(/orphaned after restart/i);
    await expect(reopened.status(started.id, toolContext(workspace, undefined, "other-run")))
      .rejects.toThrow(/outside the current run|unknown process job/i);
  });

  it("waits for child termination before persisting a close snapshot", async () => {
    const workspace = await temporaryDirectory();
    const registryPath = path.join(workspace, "process-jobs.json");
    const registry = await FileProcessJobRegistry.open(registryPath);
    const manager = new ProcessJobManager({
      registry,
      defaultTimeoutSeconds: 2,
    });
    managers.push(manager);
    const context = toolContext(workspace);
    const started = await manager.start({ command: "sleep 2" }, context);

    await manager.close();

    const entries = await registry.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.snapshot).toMatchObject({
      id: started.id,
      state: "killed",
    });
    expect(entries[0]?.snapshot.endedAt).toEqual(expect.any(String));
  });

  it("does not spawn when close wins during workspace resolution", async () => {
    const workspace = await temporaryDirectory();
    let manager!: ProcessJobManager;
    let closePromise: Promise<void> | undefined;
    const registry = {
      load: async () => {
        // The initial registry await completes in the microtask queue. A
        // check-phase callback therefore runs after start's first lifecycle
        // check, while the asynchronous workspace resolution is pending.
        setImmediate(() => {
          closePromise = manager.close();
        });
        return [];
      },
      replace: async () => undefined,
    };
    manager = new ProcessJobManager({ registry });
    managers.push(manager);
    const context = toolContext(workspace);

    const starting = manager.start({ command: "sleep 1" }, context);
    await expect(starting).rejects.toThrow(/manager is closed/u);
    await closePromise;
    expect(manager.size).toBe(0);
    expect(closePromise).toBeDefined();
  });

  it("includes older-run orphan metadata only when explicitly requested", async () => {
    const workspace = await temporaryDirectory();
    const registryPath = path.join(workspace, "process-jobs.json");
    const sourceRegistry = await FileProcessJobRegistry.open(registryPath);
    const source = new ProcessJobManager({ registry: sourceRegistry, defaultTimeoutSeconds: 10 });
    managers.push(source);
    const sourceContext = toolContext(workspace, undefined, "old-run");
    const started = await source.start({ command: waitForTestRelease }, sourceContext);
    await source.flush();

    const reopened = new ProcessJobManager({
      registry: await FileProcessJobRegistry.open(registryPath),
    });
    managers.push(reopened);
    const currentContext = toolContext(workspace, undefined, "new-run");
    expect(await reopened.list(currentContext)).toHaveLength(0);
    expect((await reopened.list(currentContext, { includeOrphans: true }))[0]).toMatchObject({
      status: "orphaned",
      snapshot: { id: started.id, runId: "old-run" },
    });
    const modelVisibleList = createProcessJobTools(reopened)[4]!;
    expect(modelVisibleList.definition.parameters.properties).toEqual({});
    expect(parse(await modelVisibleList.execute({ includeOrphans: true }, currentContext)))
      .toEqual([]);
  });

  it("rolls back a started child when the initial registry write fails", async () => {
    const workspace = await temporaryDirectory();
    let replaceCalls = 0;
    let persisted: readonly unknown[] = [];
    const registry = {
      load: async () => [],
      replace: async (entries: readonly unknown[]) => {
        replaceCalls += 1;
        if (replaceCalls === 1) throw new Error("disk full");
        persisted = entries;
      },
    };
    const manager = new ProcessJobManager({
      registry,
      defaultTimeoutSeconds: 2,
    });
    managers.push(manager);

    await expect(manager.start({ command: "sleep 2" }, toolContext(workspace)))
      .rejects.toThrow(/disk full/u);
    expect(manager.size).toBe(0);
    expect(persisted).toHaveLength(0);
    await manager.flush();
    expect(manager.registryError).toBeUndefined();
  });

  it("serializes start admission so maxJobs cannot be exceeded by concurrent calls", async () => {
    const workspace = await temporaryDirectory();
    const manager = new ProcessJobManager({ maxJobs: 1, defaultTimeoutSeconds: 2 });
    managers.push(manager);
    const starts = await Promise.allSettled([
      manager.start({ command: "sleep 1" }, toolContext(workspace)),
      manager.start({ command: "sleep 1" }, toolContext(workspace)),
      manager.start({ command: "sleep 1" }, toolContext(workspace)),
    ]);
    const fulfilled = starts.filter((result) => result.status === "fulfilled");
    const rejected = starts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(manager.size).toBe(1);
  });

  it("surfaces asynchronous registry failures through diagnostics and flush", async () => {
    const workspace = await temporaryDirectory();
    const observed: Error[] = [];
    let replaceCalls = 0;
    const registry = {
      load: async () => [],
      replace: async () => {
        replaceCalls += 1;
        if (replaceCalls > 1) throw new Error("registry unavailable");
      },
    };
    const manager = new ProcessJobManager({
      registry,
      onRegistryError: (error) => observed.push(error),
      defaultTimeoutSeconds: 0.05,
      maxTimeoutSeconds: 0.1,
    });
    managers.push(manager);
    const started = await manager.start({ command: "sleep 1" }, toolContext(workspace));
    await eventually(async () => {
      expect((await manager.status(started.id, toolContext(workspace))).state).toBe("timed_out");
    });
    await expect(manager.flush()).rejects.toThrow(/registry unavailable/u);
    expect(manager.registryError).toMatchObject({ message: expect.stringMatching(/registry unavailable/u) });
    expect(observed.length).toBeGreaterThan(0);
  });
});

function parse(result: { content: string }): Record<string, any> {
  return JSON.parse(result.content) as Record<string, any>;
}

function toolContext(workspace: string, signal?: AbortSignal, runId = "run-1") {
  return {
    runId,
    workspace,
    operationId: "operation-1",
    ...(signal === undefined ? {} : { signal }),
  };
}

async function temporaryDirectory(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "nausicaa-process-jobs-"));
  workspaces.push(workspace);
  return workspace;
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
