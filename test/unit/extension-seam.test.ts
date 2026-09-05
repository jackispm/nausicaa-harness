import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXTENSION_HOOK_TIMEOUT_MS,
  ExtensionHookError,
  ExtensionHost,
  MAX_EXTENSION_HOOK_TIMEOUT_MS,
  createExtensionHost,
  type ExtensionToolCallContext,
  type ExtensionToolResultContext,
} from "../../src/runtime/extension-seam.js";

const toolContext: ExtensionToolCallContext = {
  runId: "run-1",
  laneId: "main",
  operationId: "operation-1",
  call: {
    id: "call-1",
    name: "write_file",
    arguments: { path: "a.txt", content: "hello" },
  },
  tool: {
    name: "write_file",
    description: "Write a file",
    effect: "write",
    scope: "workspace",
    requiresApproval: true,
  },
};

const resultContext: ExtensionToolResultContext = {
  ...toolContext,
  result: { content: "written", isError: false },
};

describe("ExtensionHost", () => {
  it("runs before hooks in order with immutable snapshots and returns transforms", async () => {
    const seen: unknown[] = [];
    const host = new ExtensionHost([
      {
        id: "first",
        beforeToolCall: (context) => {
          seen.push(context.call.arguments);
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.call)).toBe(true);
          expect(Object.isFrozen(context.call.arguments)).toBe(true);
          expect(() => {
            (context.call.arguments as Record<string, unknown>).path = "mutated";
          }).toThrow();
          return { action: "transform", arguments: { ...context.call.arguments, content: "first" } };
        },
      },
      {
        id: "second",
        beforeToolCall: (context) => {
          seen.push(context.call.arguments);
          expect(context.call.arguments).toEqual({ path: "a.txt", content: "first" });
          return { action: "transform", arguments: { ...context.call.arguments, content: "second" } };
        },
      },
    ]);

    const outcome = await host.runBeforeToolCall(toolContext);

    expect(outcome).toEqual({
      action: "allow",
      arguments: { path: "a.txt", content: "second" },
    });
    expect(seen).toEqual([
      { path: "a.txt", content: "hello" },
      { path: "a.txt", content: "first" },
    ]);
    expect(toolContext.call.arguments).toEqual({ path: "a.txt", content: "hello" });
  });

  it("supports deny decisions and bounds their reason", async () => {
    const host = createExtensionHost([{
      id: "policy",
      beforeToolCall: () => ({ action: "deny", reason: "x".repeat(2_000) }),
    }]);

    await expect(host.runBeforeToolCall(toolContext)).resolves.toMatchObject({
      action: "deny",
      extensionId: "policy",
      arguments: toolContext.call.arguments,
      reason: "x".repeat(1_024),
    });
  });

  it("chains after-hook replacements without mutating the source result", async () => {
    const seen: string[] = [];
    const host = new ExtensionHost([
      {
        id: "redact",
        afterToolResult: (context) => {
          seen.push(context.result.content);
          expect(Object.isFrozen(context.result)).toBe(true);
          return { content: "redacted", isError: false };
        },
      },
      {
        id: "annotate",
        afterToolResult: (context) => {
          seen.push(context.result.content);
          return { ...context.result, content: `${context.result.content} [checked]` };
        },
      },
    ]);

    await expect(host.runAfterToolResult(resultContext)).resolves.toEqual({
      content: "redacted [checked]",
      isError: false,
    });
    expect(seen).toEqual(["written", "redacted"]);
    expect(resultContext.result).toEqual({ content: "written", isError: false });
  });

  it("fails closed for malformed decisions and validates extension registration", async () => {
    const malformed = new ExtensionHost([{
      id: "malformed",
      beforeToolCall: () => null as never,
    }]);
    await expect(malformed.runBeforeToolCall(toolContext)).rejects.toMatchObject({
      name: "ExtensionHookError",
      extensionId: "malformed",
      phase: "before-tool",
    });

    expect(() => new ExtensionHost([{ id: "same" }, { id: "same" }])).toThrow(/Duplicate extension id/);
    expect(() => new ExtensionHost([{ id: "bad id" }])).toThrow(/ASCII identifier/);
    expect(() => new ExtensionHost([], { hookTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new ExtensionHost([], { hookTimeoutMs: MAX_EXTENSION_HOOK_TIMEOUT_MS + 1 })).toThrow(RangeError);
    expect(new ExtensionHost().hookTimeoutMs).toBe(DEFAULT_EXTENSION_HOOK_TIMEOUT_MS);
  });

  it("times out tool hooks and propagates parent aborts", async () => {
    const observedAbort = vi.fn();
    const host = new ExtensionHost([
      {
        id: "slow",
        beforeToolCall: async ({ signal }) => {
          signal?.addEventListener("abort", observedAbort, { once: true });
          await new Promise<void>(() => undefined);
          return { action: "allow" };
        },
      },
    ], { hookTimeoutMs: 10 });

    await expect(host.runBeforeToolCall(toolContext)).rejects.toSatisfy((error: unknown) => (
      error instanceof ExtensionHookError
      && error.extensionId === "slow"
      && error.phase === "before-tool"
      && error.timedOut
    ));
    expect(observedAbort).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const parentAbort = new Error("turn cancelled");
    controller.abort(parentAbort);
    await expect(host.runBeforeToolCall({ ...toolContext, signal: controller.signal }))
      .rejects.toBe(parentAbort);
  });

  it("isolates observational event failures and snapshots event payloads", async () => {
    const observed: unknown[] = [];
    const host = new ExtensionHost([
      {
        id: "observer",
        onEvent: (event, context) => {
          observed.push(event);
          expect(Object.isFrozen(event)).toBe(true);
          expect(Object.isFrozen(context)).toBe(true);
          throw new Error("observer unavailable");
        },
      },
      { id: "healthy", onEvent: (event) => { observed.push(event); } },
    ]);
    const payload = { nested: { value: 1 } };

    await expect(host.emit(
      { type: "custom", name: "diagnostic", payload },
      { runId: "run-1", laneId: "main" },
    )).resolves.toBeUndefined();
    expect(observed).toHaveLength(2);
    expect(payload).toEqual({ nested: { value: 1 } });
    expect(observed[0]).not.toBe(observed[1]);
  });
});
