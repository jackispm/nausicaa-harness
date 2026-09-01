import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MemoryContentAddressedStore } from "../../src/store/memory.js";
import {
  MoweAdmissionError,
  assertArguments,
  inspectSchema,
  validateArguments,
} from "../../src/mowe/admission.js";
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

  it("fails closed on type arrays with a structured schema diagnostic", () => {
    const candidate = tool({
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
      },
      additionalProperties: false,
    });

    const result = validateArguments(candidate, { value: 42 });
    expect(result).toMatchObject({
      ok: false,
      reason: "Tool schema at parameters.properties.value.type is not supported: type arrays are not implemented",
      diagnostic: {
        code: "unsupported_schema",
        path: "parameters.properties.value.type",
        keyword: "type",
      },
    });

    try {
      assertArguments(candidate, { value: "otherwise-valid" });
      throw new Error("expected schema admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MoweAdmissionError);
      expect((error as MoweAdmissionError).diagnostic).toMatchObject({
        code: "unsupported_schema",
        keyword: "type",
      });
    }
  });

  it.each(["oneOf", "anyOf", "allOf", "$ref"])(
    "rejects the unsupported %s keyword instead of ignoring its constraint",
    (keyword) => {
      const propertySchema = keyword === "$ref"
        ? { $ref: "#/$defs/value" }
        : { [keyword]: [{ type: "string" }] };
      const candidate = tool({
        type: "object",
        properties: { value: propertySchema },
        additionalProperties: false,
      });

      expect(validateArguments(candidate, { value: 42 })).toMatchObject({
        ok: false,
        diagnostic: {
          code: "unsupported_schema",
          path: `parameters.properties.value.${keyword}`,
          keyword,
        },
      });
    },
  );

  it("rejects unsupported tuple items before invoking the tool", async () => {
    let invoked = false;
    const candidate = tool({
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
      additionalProperties: false,
    }, async () => {
      invoked = true;
      return { content: "unexpected", isError: false };
    });
    const executor = new MoweExecutor({ catalog: [candidate] });

    const response = await executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: "/tmp",
      calls: [{ id: "tuple", name: "boundary", arguments: { values: ["ok", 1] } }],
    });

    expect(invoked).toBe(false);
    expect(response.results[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("tuple-form items arrays are not implemented"),
    });
  });

  it("honors boolean schemas inside supported object and array shapes", () => {
    const candidate = tool({
      type: "object",
      properties: {
        denied: false,
        values: { type: "array", items: false },
      },
      additionalProperties: false,
    });

    expect(validateArguments(candidate, { denied: "value", values: [] })).toMatchObject({
      ok: false,
      reason: "arguments.denied is rejected by the declared schema",
    });
    expect(validateArguments(candidate, { values: ["value"] })).toMatchObject({
      ok: false,
      reason: "arguments.values[0] is rejected by the declared schema",
    });
    expect(validateArguments(candidate, { values: [] })).toEqual({ ok: true });
  });

  it("shares a strict schema inspection boundary with edge normalization", () => {
    const cases: Array<{ keyword: string; schema: Record<string, unknown> }> = [
      { keyword: "pattern", schema: { type: "string", pattern: "[" } },
      { keyword: "minimum", schema: { type: "number", minimum: Number.NaN } },
      { keyword: "minLength", schema: { type: "string", minLength: -1 } },
      { keyword: "enum", schema: { type: "string", enum: [] } },
      { keyword: "enum", schema: { type: "string", enum: [{ a: 1 }, { a: 1 }] } },
      { keyword: "properties", schema: { type: "object", properties: [] } },
      { keyword: "required", schema: { type: "object", required: ["a", "a"] } },
      { keyword: "items", schema: { type: "array", items: [{ type: "string" }] } },
      { keyword: "additionalProperties", schema: { type: "object", additionalProperties: "yes" } },
    ];

    for (const candidate of cases) {
      const diagnostic = inspectSchema({
        type: "object",
        properties: { value: candidate.schema },
      }, "parameters", { requireObjectRoot: true });
      expect(diagnostic).toMatchObject({
        code: candidate.keyword === "items" ? "unsupported_schema" : "invalid_schema",
        keyword: candidate.keyword,
      });
    }
  });

  it("accepts null, boolean, arrays, and reordered objects as JSON enum/const values", () => {
    const candidate = tool({
      type: "object",
      properties: {
        choice: {
          enum: [null, false, [1, "two"], { a: 1, b: 2 }],
        },
        value: {
          const: { b: 2, a: 1 },
        },
      },
    });
    expect(validateArguments(candidate, { choice: { b: 2, a: 1 }, value: { a: 1, b: 2 } }))
      .toEqual({ ok: true });
    expect(validateArguments(candidate, { choice: 1, value: { a: 1, b: 2 } }))
      .toMatchObject({ ok: false, reason: "arguments.choice must be one of the declared values" });
    expect(inspectSchema(candidate.definition.parameters, "parameters", { requireObjectRoot: true }))
      .toBeUndefined();
  });

  it("keeps a legacy schema without properties open", () => {
    const candidate = tool({ type: "object", additionalProperties: false });
    expect(validateArguments(candidate, { legacy: "value" })).toEqual({ ok: true });
  });

  it("keeps a legacy schema-valued additionalProperties envelope open without properties", () => {
    const candidate = tool({
      type: "object",
      additionalProperties: { type: "string" },
    } as unknown as AgentTool["definition"]["parameters"]);
    expect(validateArguments(candidate, { legacy: "value" })).toEqual({ ok: true });
    expect(validateArguments(candidate, { legacy: 42 })).toEqual({ ok: true });
  });

  it("requires own JSON members and rejects sparse required arrays", () => {
    const candidate = tool({
      type: "object",
      properties: { toString: { type: "string" } },
      required: ["toString"],
    });
    expect(validateArguments(candidate, {})).toMatchObject({
      ok: false,
      reason: "arguments.toString is required",
    });
    const sparse = new Array(1) as unknown as string[];
    expect(inspectSchema({ type: "object", required: sparse }, "parameters", {
      requireObjectRoot: true,
    })).toMatchObject({
      code: "invalid_schema",
      keyword: "required",
    });
  });

  it("does not treat inherited object members as optional arguments", () => {
    const candidate = tool({
      type: "object",
      properties: { toString: { type: "string" } },
      additionalProperties: false,
    });

    expect(validateArguments(candidate, {})).toEqual({ ok: true });
    expect(validateArguments(candidate, { toString: "explicit" })).toEqual({ ok: true });
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
