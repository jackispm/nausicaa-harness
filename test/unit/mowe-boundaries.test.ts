import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";
import { validateArguments } from "../../src/mowe/admission.js";
import {
  MoweCatalog,
  resolveMetadata,
} from "../../src/mowe/catalog.js";
import { MoweExecutor } from "../../src/mowe/executor.js";

function tool(parameters: AgentTool["definition"]["parameters"], execute?: AgentTool["execute"]): AgentTool {
  return {
    definition: { name: "boundary", description: "boundary test tool", parameters },
    execute: execute ?? (async () => ({ content: "ok", isError: false })),
  };
}

describe("Mowe boundaries", () => {
  it("admits nested schemas and enforces common JSON Schema constraints", () => {
    const candidate = tool({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "safe"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
        options: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
      required: ["mode", "count", "tags", "options"],
      additionalProperties: false,
    });

    expect(validateArguments(candidate, {
      mode: "safe",
      count: 2,
      tags: ["one"],
      options: { enabled: true },
    })).toEqual({ ok: true });
    expect(validateArguments(candidate, {
      mode: "unsafe",
      count: 2,
      tags: ["one"],
      options: { enabled: true },
    })).toMatchObject({ ok: false, reason: "arguments.mode must be one of the declared values" });
    expect(validateArguments(candidate, {
      mode: "safe",
      count: 4,
      tags: ["one"],
      options: { enabled: true },
    })).toMatchObject({ ok: false, reason: "arguments.count must be less than or equal to 3" });
    expect(validateArguments(candidate, {
      mode: "safe",
      count: 2,
      tags: ["one", 3],
      options: { enabled: true },
    })).toMatchObject({ ok: false, reason: "arguments.tags[1] must be string" });
    expect(validateArguments(candidate, {
      mode: "safe",
      count: 2,
      tags: ["one"],
      options: {},
    })).toMatchObject({ ok: false, reason: "arguments.options.enabled is required" });
  });

  it("keeps a legacy schema without properties open", () => {
    const candidate = tool({ type: "object", additionalProperties: false });
    expect(validateArguments(candidate, { legacy: "value" })).toEqual({ ok: true });
  });

  it("freezes catalog entries and rejects invalid metadata declarations", () => {
    const catalog = new MoweCatalog([tool({ type: "object", additionalProperties: false })]);
    const entry = catalog.get("boundary");
    expect(entry).toBeDefined();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.metadata)).toBe(true);
    expect(Object.isFrozen(catalog.capabilities()[0]?.metadata)).toBe(true);

    expect(() => resolveMetadata({ effect: "unsafe" as never })).toThrow(/effect/u);
    expect(() => resolveMetadata({ scope: "global" as never })).toThrow(/scope/u);
    expect(() => resolveMetadata({ deterministic: "yes" as never })).toThrow(/deterministic/u);
  });

  it("returns isolated nested parameter schemas from public definition snapshots", () => {
    const catalog = new MoweCatalog([tool({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
        },
      },
      additionalProperties: false,
    })]);

    const modelDefinition = catalog.modelDefinitions()[0]!;
    const hostDefinition = catalog.definitions()[0]!;
    (modelDefinition.parameters.properties as Record<string, any>).nested.properties.enabled.type = "string";
    (hostDefinition.parameters.properties as Record<string, any>).nested.properties.enabled.type = "number";

    const live = catalog.get("boundary")!.tool.definition.parameters;
    expect((live.properties as Record<string, any>).nested.properties.enabled.type).toBe("boolean");
    expect(catalog.modelDefinitions()[0]!.parameters.properties).toEqual({
      nested: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
      },
    });
  });

  it("rejects blank or duplicate caller-owned operation IDs", async () => {
    const executor = new MoweExecutor({ catalog: [tool({ type: "object", additionalProperties: false })] });
    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "one", name: "boundary", operationId: "  ", arguments: {} }],
    })).rejects.toThrow("Operation ids must not be empty");
    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "one", name: "boundary", operationId: "op-1", arguments: {} },
        { id: "two", name: "boundary", operationId: "op-1", arguments: {} },
      ],
    })).rejects.toThrow("Duplicate operation id: op-1");
  });

  it("rejects malformed projections before invoking a side-effecting tool", async () => {
    let invoked = 0;
    const mutating = tool(
      { type: "object", additionalProperties: false },
      async () => {
        invoked += 1;
        return { content: "mutated", isError: false };
      },
    );
    const catalog = new MoweCatalog();
    catalog.register(mutating, { effect: "write", scope: "workspace" });
    const executor = new MoweExecutor({ catalog });

    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      projection: { maxBytes: 0 },
      calls: [{ id: "invalid-default", name: "boundary", arguments: {} }],
    })).rejects.toThrow("projection.maxBytes must be a positive integer");
    await expect(executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [{
        id: "invalid-call",
        name: "boundary",
        arguments: {},
        projection: { mode: "unknown" as never },
      }],
    })).rejects.toThrow("Tool call projection (invalid-call).mode is invalid");
    expect(invoked).toBe(0);
  });

  it("sanitizes thrown tool errors before exposing bounded output", async () => {
    const secret = "Authorization: Bearer super-secret-token";
    const failing = tool(
      { type: "object", additionalProperties: false },
      async () => {
        throw new Error(secret);
      },
    );
    const store = new MemoryContentAddressedStore();
    const executor = new MoweExecutor({
      catalog: [failing],
      sanitizeResult: (result) => ({
        ...result,
        content: result.content.replace("super-secret-token", "[REDACTED]"),
      }),
    });
    const response = await executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 8 },
      artifactStore: store,
      calls: [{ id: "throws", name: "boundary", arguments: {} }],
    });

    const result = response.results[0]!;
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain(secret);
    expect(result.projection).toBeUndefined();
    expect(Buffer.byteLength(result.result.content, "utf8")
      + Buffer.byteLength(result.error ?? "", "utf8")).toBeLessThanOrEqual(8);
  });

  it("bounds failed result errors together with aggregate output", async () => {
    const full = "0123456789abcdef";
    const failing = tool(
      { type: "object", additionalProperties: false },
      async () => ({ content: full, isError: true }),
    );
    const store = new MemoryContentAddressedStore();
    const response = await new MoweExecutor({ catalog: [failing] }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 8 },
      artifactStore: store,
      calls: [{ id: "failed", name: "boundary", arguments: {} }],
    });
    const result = response.results[0]!;
    expect(result.status).toBe("failed");
    expect(result.error).toBe(result.result.content);
    expect(Buffer.byteLength(result.result.content, "utf8")
      + Buffer.byteLength(result.error ?? "", "utf8")).toBeLessThanOrEqual(8);
    expect(result.projection).toBeUndefined();
  });

  it("keeps artifact retention failures within their reserved output", async () => {
    let artifactBytes = 0;
    const response = await new MoweExecutor({
      catalog: [tool(
        { type: "object", additionalProperties: false },
        async () => ({ content: "data", isError: false }),
      )],
    }).execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 8 },
      artifactStore: {
        put: async (data) => {
          artifactBytes += typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data.byteLength;
          throw new Error("artifact storage unavailable");
        },
      },
      calls: [{
        id: "artifact-failure",
        name: "boundary",
        arguments: {},
        projection: { mode: "artifact" },
      }],
    });

    const result = response.results[0]!;
    expect(result.status).toBe("failed");
    expect(result.projection).toBeUndefined();
    const returnedBytes = Buffer.byteLength(result.result.content, "utf8")
      + Buffer.byteLength(result.error ?? "", "utf8");
    expect(artifactBytes + returnedBytes).toBeLessThanOrEqual(8);
    expect(returnedBytes).toBe(0);
  });
});
