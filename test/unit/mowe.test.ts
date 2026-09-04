import { describe, expect, it } from "vitest";
import type { UserImage } from "../../src/domain/images.js";
import type { AgentTool } from "../../src/domain/ports.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";
import {
  FIRST_PARTY_MOWE_METADATA,
  MoweCatalog,
  annotateTool,
  resolveMetadata,
} from "../../src/mowe/catalog.js";
import { MoweExecutor, operationIdFor } from "../../src/mowe/executor.js";
import {
  projectResult,
  serializeToolResult,
  toolResultByteLength,
} from "../../src/mowe/result-projector.js";
import type { MoweApprovalDecisionRecord } from "../../src/mowe/types.js";
import { sha256, stableJson } from "../../src/ledger/hash.js";
import { createWorkspaceMoweCatalog } from "../../src/mowe/workspace-catalog.js";

function echoTool(): AgentTool {
  return {
    definition: {
      name: "echo",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      return { content: String(args.text), isError: false };
    },
  };
}

function sampleImage(): UserImage {
  return { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Mowe", () => {
  it("normalizes legacy tool names for registration, lookup, and model schemas", () => {
    const tool: AgentTool = {
      ...echoTool(),
      definition: { ...echoTool().definition, name: "  echo  " },
    };
    const catalog = new MoweCatalog();
    catalog.register(tool, { version: "trimmed" });
    expect(catalog.get("echo")?.tool.definition.name).toBe("echo");
    expect(catalog.get(" echo ")?.metadata.version).toBe("trimmed");
    expect(catalog.modelDefinitions().map((definition) => definition.name)).toEqual(["echo"]);
    expect(catalog.unregister(" echo ")).toBe(true);
  });

  it("executes one or many calls and preserves input order", async () => {
    const executor = new MoweExecutor({ catalog: new MoweCatalog([echoTool()]), maxConcurrency: 2 });
    const response = await executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "a", name: "echo", arguments: { text: "first" } },
        { id: "b", name: "echo", arguments: { text: "second" } },
      ],
    });
    expect(response.results.map((item) => item.result.content)).toEqual(["first", "second"]);
    expect(response.results[0]?.operationId).toBe(operationIdFor({ runId: "run-1", laneId: "main" }, {
      id: "a", name: "echo", arguments: { text: "first" },
    }, 0));
  });

  it("enforces batch call/input limits before invoking tools", async () => {
    let invoked = 0;
    const tool: AgentTool = {
      ...echoTool(),
      async execute(args) {
        invoked += 1;
        return { content: String(args.text), isError: false };
      },
    };
    const executor = new MoweExecutor({ catalog: [tool] });
    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxCalls: 1 },
      calls: [
        { id: "a", name: "echo", arguments: { text: "a" } },
        { id: "b", name: "echo", arguments: { text: "b" } },
      ],
    })).rejects.toThrow("Batch contains 2 calls; limit is 1");
    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxInputBytes: 1 },
      calls: [{ id: "a", name: "echo", arguments: { text: "a" } }],
    })).rejects.toThrow("Batch call input");
    expect(invoked).toBe(0);
  });

  it("bounds aggregate output without persisting overflow outside the budget", async () => {
    const store = new MemoryContentAddressedStore();
    let artifactBytes = 0;
    const response = await new MoweExecutor({ catalog: [echoTool()] }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 10 },
      artifactStore: {
        put: async (data, mediaType) => {
          artifactBytes += typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data.byteLength;
          return store.put(data, mediaType);
        },
      },
      calls: [
        { id: "a", name: "echo", arguments: { text: "1234567890" } },
        { id: "b", name: "echo", arguments: { text: "abcdefghij" } },
      ],
    });
    const first = response.results[0]!;
    const second = response.results[1]!;
    expect(Buffer.byteLength(first.result.content, "utf8")).toBe(10);
    expect(Buffer.byteLength(second.result.content, "utf8")).toBe(0);
    expect(second).not.toHaveProperty("durableResult");
    expect(second.projection).toBeUndefined();
    expect(artifactBytes).toBe(0);
  });

  it("charges projection and artifact payloads to the same output budget", async () => {
    const store = new MemoryContentAddressedStore();
    let artifactBytes = 0;
    const response = await new MoweExecutor({ catalog: [echoTool()] }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 42 },
      artifactStore: {
        put: async (data, mediaType) => {
          artifactBytes += typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data.byteLength;
          return store.put(data, mediaType);
        },
      },
      calls: [{
        id: "preview",
        name: "echo",
        arguments: { text: "0123456789" },
        projection: { mode: "preview", maxBytes: 4 },
      }],
    });
    const item = response.results[0]!;
    const resultBytes = toolResultByteLength(item.result);
    const projectionBytes = Buffer.byteLength(item.projection?.content ?? "", "utf8");

    expect(item.projection?.artifactRef).toBeDefined();
    expect(resultBytes + projectionBytes + artifactBytes).toBeLessThanOrEqual(42);
    expect(artifactBytes).toBe(10);
  });

  it("falls back to bounded inline output when an explicit artifact cannot fit", async () => {
    const store = new MemoryContentAddressedStore();
    let puts = 0;
    const response = await new MoweExecutor({ catalog: [echoTool()] }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 5 },
      artifactStore: {
        put: async (data, mediaType) => {
          puts += 1;
          return store.put(data, mediaType);
        },
      },
      calls: [{
        id: "artifact",
        name: "echo",
        arguments: { text: "0123456789" },
        projection: { mode: "artifact" },
      }],
    });

    expect(puts).toBe(0);
    expect(response.results[0]?.projection).toBeUndefined();
    expect(toolResultByteLength(response.results[0]!.result)).toBeLessThanOrEqual(5);
  });

  it("keeps a multimodal projection inline and in a recoverable artifact", async () => {
    const result = { content: "caption", isError: false, images: [sampleImage()] };
    const expected = serializeToolResult(result);
    const inline = await projectResult(result, { mode: "inline" });
    expect(inline).toMatchObject({
      mode: "inline",
      content: "caption",
      byteLength: expected.bytes.byteLength,
      truncated: false,
      images: result.images,
    });

    const store = new MemoryContentAddressedStore();
    const artifact = await projectResult(result, { mode: "artifact" }, store);
    expect(artifact).toMatchObject({
      mode: "artifact",
      byteLength: expected.bytes.byteLength,
      truncated: false,
      artifactRef: { mediaType: "application/json" },
    });
    const recovered = JSON.parse(
      Buffer.from(await store.get(artifact.artifactRef!)).toString("utf8"),
    ) as unknown;
    expect(recovered).toEqual(result);
  });

  it("counts multimodal payload bytes and removes oversized images from bounded output", async () => {
    const image = sampleImage();
    const tool: AgentTool = {
      definition: {
        name: "image_result",
        description: "Return an image",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: "caption", isError: false, images: [image] };
      },
    };
    const full = { content: "caption", isError: false, images: [image] };
    const fullLength = toolResultByteLength(full);
    const maxOutputBytes = fullLength - 1;
    const store = new MemoryContentAddressedStore();
    let artifactBytes = 0;
    const response = await new MoweExecutor({ catalog: [tool] }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes },
      artifactStore: {
        put: async (data, mediaType) => {
          artifactBytes += typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data.byteLength;
          return store.put(data, mediaType);
        },
      },
      calls: [{ id: "image", name: "image_result", arguments: {} }],
    });
    const item = response.results[0]!;
    expect(item.result.images).toBeUndefined();
    expect(toolResultByteLength(item.result)).toBeLessThanOrEqual(maxOutputBytes);
    expect(item.projection).toBeUndefined();
    expect(artifactBytes).toBe(0);
  });

  it("executes supportsBatch false calls independently in one batch envelope", async () => {
    let invocations = 0;
    const nonNativeBatchTool: AgentTool = {
      definition: {
        name: "non_native_batch",
        description: "A tool without a native merged-call API",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        invocations += 1;
        return { content: "ok", isError: false };
      },
    };
    const catalog = new MoweCatalog();
    catalog.register(nonNativeBatchTool, {
      supportsBatch: false,
      concurrencySafe: false,
    });
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "one", name: "non_native_batch", arguments: {} },
        { id: "two", name: "non_native_batch", arguments: {} },
      ],
    });
    expect(invocations).toBe(2);
    expect(response.results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("cancels pending work when the batch deadline expires", async () => {
    const tool: AgentTool = {
      definition: {
        name: "slow_batch",
        description: "Wait for cancellation",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute(_args, context) {
        return await new Promise<{ content: string; isError: boolean }>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      },
    };
    const catalog = new MoweCatalog();
    catalog.register(tool, { effect: "external" });
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { deadlineMs: 5 },
      calls: [{ id: "a", name: "slow_batch", arguments: {} }],
    });
    expect(response.cancelled).toBe(true);
    expect(response.results[0]?.status).toBe("cancelled");
  });

  it("keeps failures per item and validates arguments", async () => {
    const executor = new MoweExecutor({ catalog: [echoTool()] });
    const response = await executor.execute({
      runId: "run-1", laneId: "main", workspace: "/tmp",
      calls: [
        { id: "bad", name: "echo", arguments: {} },
        { id: "unknown", name: "missing", arguments: {} },
      ],
    });
    expect(response.results.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(response.results[0]?.error).toContain("text is required");
    expect(response.results[1]?.error).toContain("Unknown tool");
  });

  it("preserves runtime forced failures before schema admission", async () => {
    const executor = new MoweExecutor({ catalog: [echoTool()] });
    const response = await executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [{
        id: "truncated",
        name: "echo",
        arguments: {},
        forcedError: "Tool call was truncated by the model output limit",
      }],
    });
    expect(response.results[0]).toMatchObject({
      status: "failed",
      error: "Tool call was truncated by the model output limit",
    });
  });

  it("propagates a declared cooperative timeout and records a timeout failure", async () => {
    let observedSignal: AbortSignal | undefined;
    const timed: AgentTool = {
      definition: {
        name: "timed",
        description: "Wait for the adapter deadline",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute(_args, context) {
        const signal = context.signal;
        observedSignal = signal;
        if (signal === undefined) throw new Error("Mowe did not provide a deadline signal");
        return await new Promise<{ content: string; isError: boolean }>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const catalog = new MoweCatalog();
    catalog.register(timed, { effect: "external", timeoutMs: 5 });
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "timed", name: "timed", arguments: {} }],
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(response.results[0]).toMatchObject({
      status: "failed",
      error: "Tool timed out after 5ms",
    });
  });

  it("keeps serialized calls occupied until an uncooperative adapter settles", async () => {
    const events: string[] = [];
    const mutate: AgentTool = {
      definition: {
        name: "slow_mutate",
        description: "Slow mutation",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute(args) {
        const id = String(args.id);
        events.push(`start:${id}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        events.push(`end:${id}`);
        return { content: id, isError: false };
      },
    };
    const catalog = new MoweCatalog();
    catalog.register(mutate, {
      effect: "write",
      concurrencySafe: false,
      timeoutMs: 5,
    });
    const response = await new MoweExecutor({ catalog, maxConcurrency: 2 }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      concurrency: 2,
      calls: [
        { id: "a", name: "slow_mutate", arguments: { id: "a" } },
        { id: "b", name: "slow_mutate", arguments: { id: "b" } },
      ],
    });

    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(response.results.map((result) => result.status)).toEqual(["failed", "failed"]);
  });

  it("supports deterministic projections and artifact storage", async () => {
    const executor = new MoweExecutor({ catalog: [echoTool()] });
    const store = new MemoryContentAddressedStore();
    const response = await executor.execute({
      runId: "run-1", laneId: "main", workspace: "/tmp", artifactStore: store,
      calls: [
        { id: "p", name: "echo", arguments: { text: "0123456789" }, projection: { mode: "preview", maxBytes: 4 } },
        { id: "s", name: "echo", arguments: { text: "line1\nline2" }, projection: { mode: "summary" } },
        { id: "a", name: "echo", arguments: { text: "stored" }, projection: { mode: "artifact" } },
      ],
    });
    expect(response.results[0]?.projection?.content).toContain("0123");
    expect(response.results[0]?.projection?.truncated).toBe(true);
    expect(response.results[1]?.projection?.content).toContain('"lineCount":2');
    expect(response.results[2]?.projection?.artifactRef?.contentHash).toMatch(/^sha256:/);
  });

  it("returns cancelled items without invoking tools after abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let invoked = false;
    const tool: AgentTool = {
      ...echoTool(),
      async execute(args) {
        invoked = true;
        return { content: String(args.text), isError: false };
      },
    };
    const executor = new MoweExecutor({ catalog: [tool] });
    const response = await executor.execute({
      runId: "run-1", laneId: "main", workspace: "/tmp", signal: controller.signal,
      calls: [{ id: "a", name: "echo", arguments: { text: "never" } }],
    });
    expect(invoked).toBe(false);
    expect(response.cancelled).toBe(true);
    expect(response.results[0]?.status).toBe("cancelled");
  });

  it("keeps the complete first-party workspace surface in one catalog", () => {
    const catalog = createWorkspaceMoweCatalog({ allowWrite: true, allowPathOperations: true, allowShell: true });
    expect(catalog.modelDefinitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "write_file",
      "edit",
      "apply_patch",
      "directory_create",
      "path_copy",
      "path_move",
      "path_delete",
      "bash",
    ]);

    const read = catalog.capabilities().find((capability) => capability.name === "read_file");
    expect(read?.metadata).toMatchObject({
      effect: "read",
      deterministic: true,
      supportsBatch: true,
      concurrencySafe: true,
      scope: "workspace",
      inputKinds: ["text"],
      outputKinds: ["json", "text"],
    });

    const shell = catalog.capabilities().find((capability) => capability.name === "bash");
    expect(shell?.metadata).toMatchObject({
      effect: "external",
      deterministic: false,
      concurrencySafe: false,
      scope: "workspace",
    });
    expect(catalog.definitions().find((definition) => definition.name === "bash"))
      .toHaveProperty("metadata");
    expect(catalog.modelDefinitions().find((definition) => definition.name === "bash"))
      .not.toHaveProperty("metadata");

    const networkCatalog = createWorkspaceMoweCatalog({
      allowWrite: true,
      allowPathOperations: true,
      allowShell: true,
      allowNetwork: true,
    });
    expect(networkCatalog.modelDefinitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "web_fetch",
      "web_search",
      "write_file",
      "edit",
      "apply_patch",
      "directory_create",
      "path_copy",
      "path_move",
      "path_delete",
      "bash",
    ]);

    const fullCatalog = createWorkspaceMoweCatalog({
      allowImages: true,
      allowNetwork: true,
      allowWrite: true,
      allowPathOperations: true,
      allowShell: true,
    });
    expect(fullCatalog.modelDefinitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "read_image",
      "web_fetch",
      "web_search",
      "write_file",
      "edit",
      "apply_patch",
      "directory_create",
      "path_copy",
      "path_move",
      "path_delete",
      "bash",
    ]);
    expect(fullCatalog.capabilities().find((capability) => capability.name === "read_image"))
      .toMatchObject({ metadata: { effect: "read", outputKinds: ["image", "json"] } });

    const jobsCatalog = createWorkspaceMoweCatalog({
      allowShell: true,
      allowProcessJobs: true,
    });
    expect(jobsCatalog.modelDefinitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "bash",
      "process_start",
      "process_status",
      "process_output",
      "process_kill",
      "process_list",
    ]);
    expect(jobsCatalog.capabilities().find((capability) => capability.name === "process_start"))
      .toMatchObject({
        metadata: {
          effect: "external",
          scope: "run",
          concurrencySafe: false,
        },
      });
    expect(jobsCatalog.capabilities().find((capability) => capability.name === "process_status"))
      .toMatchObject({ metadata: { effect: "read", concurrencySafe: true, supportsBatch: true } });
    expect(jobsCatalog.capabilities().find((capability) => capability.name === "process_kill"))
      .toMatchObject({ metadata: { effect: "external", concurrencySafe: false, supportsBatch: false } });
  });

  it("keeps legacy AgentTool calls compatible while allowing explicit effect tightening", async () => {
    const catalog = new MoweCatalog([echoTool()]);
    expect(catalog.capabilities()[0]?.metadata).toMatchObject({
      effect: "read",
      deterministic: true,
      supportsBatch: true,
      concurrencySafe: true,
    });

    const executor = new MoweExecutor({ catalog });
    const allowed = await executor.execute({
      runId: "run-1",
      laneId: "worker",
      workspace: "/tmp",
      allowedEffects: ["read"],
      calls: [{ id: "legacy", name: "echo", arguments: { text: "value" } }],
    });
    expect(allowed.results[0]?.status).toBe("succeeded");

    catalog.unregister("echo");
    catalog.register(echoTool(), { effect: "external", deterministic: false, concurrencySafe: false });
    const denied = await new MoweExecutor({ catalog }).execute({
      runId: "run-1",
      laneId: "worker",
      workspace: "/tmp",
      allowedEffects: ["read"],
      calls: [{ id: "explicit", name: "echo", arguments: { text: "value" } }],
    });
    expect(denied.results[0]?.error).toContain("effect is not allowed");
  });

  it("normalizes metadata and validates capability declarations", () => {
    expect(resolveMetadata(FIRST_PARTY_MOWE_METADATA.read_file, "read_file")).toMatchObject({
      effect: "read",
      inputKinds: ["text"],
      outputKinds: ["json", "text"],
    });
    expect(resolveMetadata(FIRST_PARTY_MOWE_METADATA.respond_to_advice, "respond_to_advice"))
      .toMatchObject({
        effect: "write",
        deterministic: false,
        supportsBatch: false,
        concurrencySafe: false,
        scope: "run",
      });
    // Keep the fallback path aligned with the first-party declaration when a
    // host registers an advice tool without explicitly passing metadata.
    expect(resolveMetadata({}, "respond_to_advice")).toMatchObject({ effect: "write" });
    expect(() => resolveMetadata({ timeoutMs: 0 })).toThrow(/timeoutMs/u);
    expect(() => resolveMetadata({ inputKinds: ["video" as never] })).toThrow(/data kind/u);
    expect(() => resolveMetadata({ maxConcurrency: 65 })).toThrow(/between 1 and 64/u);
  });

  it("enforces explicit scope and approval boundaries without changing AgentTool calls", async () => {
    const tool = echoTool();
    const catalog = new MoweCatalog();
    catalog.register(tool, {
      effect: "external",
      scope: "host",
      requiresApproval: true,
    });
    const executor = new MoweExecutor({ catalog });
    const request = {
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      allowedScopes: ["host"] as const,
      calls: [{ id: "approved", name: "echo", arguments: { text: "value" } }],
    };
    const missingApproval = await executor.execute(request);
    expect(missingApproval.results[0]?.error).toContain("requires approval");

    const denied = await executor.execute({
      ...request,
      approve: () => ({ approved: false, reason: "user declined" }),
    });
    expect(denied.results[0]?.error).toContain("user declined");

    const approved = await executor.execute({
      ...request,
      approve: ({ operationId, call }) => {
        expect(operationId).toMatch(/^op:/u);
        expect(call.name).toBe("echo");
        return true;
      },
    });
    expect(approved.results[0]?.status).toBe("succeeded");

    const scopeDenied = await executor.execute({
      ...request,
      allowedScopes: ["workspace"],
      approve: () => true,
    });
    expect(scopeDenied.results[0]?.error).toContain("scope is not allowed");
  });

  it("records approval lifecycle in order with a stable hash and approved decision", async () => {
    let executions = 0;
    const order: string[] = [];
    const guardedTool: AgentTool = {
      ...echoTool(),
      async execute(args) {
        order.push("execute");
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    };
    const catalog = new MoweCatalog();
    catalog.register(guardedTool, { effect: "external", requiresApproval: true });
    const records: Array<{
      type: "requested" | "decided";
      operationId: string;
      toolCallId: string;
      name: string;
      argumentsHash?: string;
      decision?: MoweApprovalDecisionRecord;
    }> = [];
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-lifecycle",
      laneId: "main",
      workspace: "/tmp",
      calls: [{
        id: "guarded-call",
        name: "echo",
        arguments: { text: "sensitive-value" },
      }],
      approve: () => {
        order.push("callback");
        return true;
      },
      approvalLifecycle: {
        requested(context, argumentsHash) {
          order.push("requested");
          records.push({
            type: "requested",
            operationId: context.operationId,
            toolCallId: context.call.id,
            name: context.call.name,
            argumentsHash,
          });
          expect(executions).toBe(0);
        },
        decided(context, decision) {
          order.push("decided");
          records.push({
            type: "decided",
            operationId: context.operationId,
            toolCallId: context.call.id,
            name: context.call.name,
            decision,
          });
          expect(executions).toBe(0);
        },
      },
    });

    expect(response.results[0]?.status).toBe("succeeded");
    expect(executions).toBe(1);
    expect(order).toEqual(["requested", "callback", "decided", "execute"]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: "requested",
      operationId: records[1]?.operationId,
      toolCallId: "guarded-call",
      name: "echo",
      argumentsHash: sha256(stableJson({ text: "sensitive-value" })),
    });
    expect(records[0]?.argumentsHash).not.toContain("sensitive-value");
    expect(records[1]).toMatchObject({
      type: "decided",
      operationId: records[0]?.operationId,
      toolCallId: "guarded-call",
      name: "echo",
      decision: { decision: "approved" },
    });
  });

  it("records denied approvals and never invokes the guarded tool", async () => {
    let executions = 0;
    const catalog = new MoweCatalog();
    catalog.register({
      ...echoTool(),
      async execute(args) {
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    }, { effect: "external", requiresApproval: true });
    const decisions: MoweApprovalDecisionRecord[] = [];
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-denied",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "denied-call", name: "echo", arguments: { text: "value" } }],
      approve: () => ({ approved: false, reason: "operator declined" }),
      approvalLifecycle: {
        requested: () => undefined,
        decided: (_context, decision) => {
          decisions.push(decision);
        },
      },
    });

    expect(response.results[0]).toMatchObject({ status: "failed" });
    expect(response.results[0]?.error).toContain("operator declined");
    expect(executions).toBe(0);
    expect(decisions).toEqual([{ decision: "denied", reason: "operator declined" }]);
  });

  it("records a denied terminal decision when no approval handler is configured", async () => {
    let executions = 0;
    const catalog = new MoweCatalog();
    catalog.register({
      ...echoTool(),
      async execute(args) {
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    }, { effect: "external", requiresApproval: true });
    const lifecycle: string[] = [];
    const decisions: MoweApprovalDecisionRecord[] = [];
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-no-handler",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "missing-handler", name: "echo", arguments: { text: "value" } }],
      approvalLifecycle: {
        requested: () => {
          lifecycle.push("requested");
        },
        decided: (_context, decision) => {
          lifecycle.push("decided");
          decisions.push(decision);
        },
      },
    });

    expect(response.results[0]?.status).toBe("failed");
    expect(response.results[0]?.error).toContain("requires approval");
    expect(executions).toBe(0);
    expect(lifecycle).toEqual(["requested", "decided"]);
    expect(decisions).toEqual([{
      decision: "denied",
      reason: "No approval handler configured",
    }]);
  });

  it("turns an approval race with cancellation into a cancelled decision", async () => {
    const controller = new AbortController();
    const approvalStarted = deferred<void>();
    const releaseApproval = deferred<boolean>();
    let executions = 0;
    const catalog = new MoweCatalog();
    catalog.register({
      ...echoTool(),
      async execute(args) {
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    }, { effect: "external", requiresApproval: true });
    const decisions: MoweApprovalDecisionRecord[] = [];
    const pending = new MoweExecutor({ catalog }).execute({
      runId: "run-approval-cancelled",
      laneId: "main",
      workspace: "/tmp",
      signal: controller.signal,
      calls: [{ id: "cancelled-call", name: "echo", arguments: { text: "value" } }],
      approve: async () => {
        approvalStarted.resolve();
        return releaseApproval.promise;
      },
      approvalLifecycle: {
        requested: () => undefined,
        decided: (_context, decision) => {
          decisions.push(decision);
        },
      },
    });
    await approvalStarted.promise;
    controller.abort(new Error("operator cancelled"));
    releaseApproval.resolve(true);
    const response = await pending;

    expect(response.cancelled).toBe(true);
    expect(response.results[0]?.status).toBe("cancelled");
    expect(executions).toBe(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("cancelled");
    expect(decisions[0]?.reason).toContain("operator cancelled");
  });

  it("fails closed when the approval callback throws", async () => {
    let executions = 0;
    const catalog = new MoweCatalog();
    catalog.register({
      ...echoTool(),
      async execute(args) {
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    }, { effect: "external", requiresApproval: true });
    const decisions: MoweApprovalDecisionRecord[] = [];
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-callback-error",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "error-call", name: "echo", arguments: { text: "value" } }],
      approve: async () => {
        throw new Error("approval backend offline");
      },
      approvalLifecycle: {
        requested: () => undefined,
        decided: (_context, decision) => {
          decisions.push(decision);
        },
      },
    });

    expect(response.results[0]?.status).toBe("failed");
    expect(response.results[0]?.error).toContain("approval backend offline");
    expect(executions).toBe(0);
    expect(decisions).toEqual([{
      decision: "denied",
      reason: "Approval callback failed: approval backend offline",
    }]);
  });

  it("fails closed when either approval lifecycle write fails", async () => {
    let executions = 0;
    const catalog = new MoweCatalog();
    catalog.register({
      ...echoTool(),
      async execute(args) {
        executions += 1;
        return { content: String(args.text), isError: false };
      },
    }, { effect: "external", requiresApproval: true });
    let approveCalls = 0;
    const requestedFailure = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-requested-write-error",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "requested-error", name: "echo", arguments: { text: "value" } }],
      approve: () => {
        approveCalls += 1;
        return true;
      },
      approvalLifecycle: {
        requested: () => {
          throw new Error("journal unavailable");
        },
        decided: () => undefined,
      },
    });
    expect(requestedFailure.results[0]?.status).toBe("failed");
    expect(requestedFailure.results[0]?.error).toContain("journal unavailable");
    expect(approveCalls).toBe(0);
    expect(executions).toBe(0);

    const decidedFailure = await new MoweExecutor({ catalog }).execute({
      runId: "run-approval-decided-write-error",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "decided-error", name: "echo", arguments: { text: "value" } }],
      approve: () => true,
      approvalLifecycle: {
        requested: () => undefined,
        decided: () => {
          throw new Error("journal commit failed");
        },
      },
    });
    expect(decidedFailure.results[0]?.status).toBe("failed");
    expect(decidedFailure.results[0]?.error).toContain("journal commit failed");
    expect(executions).toBe(0);
  });

  it("offers a non-invasive metadata adapter for custom capabilities", () => {
    const annotated = annotateTool(echoTool(), {
      effect: "compute",
      version: "custom-1",
      outputKinds: ["json"],
    });
    expect(annotated.definition.name).toBe("echo");
    expect(annotated.metadata).toMatchObject({ effect: "compute", version: "custom-1" });
    const catalog = new MoweCatalog([annotated]);
    expect(catalog.get("echo")?.metadata.outputKinds).toEqual(["json"]);
  });
});
