import type { EventId, LaneId, RunId, ToolCall } from "../domain/types.js";
import type { ToolResult } from "../domain/ports.js";
import type { MoweToolEntry } from "../mowe/types.js";

/** Keep extension code bounded so a misbehaving hook cannot hold an effect gate forever. */
export const DEFAULT_EXTENSION_HOOK_TIMEOUT_MS = 2_000;
export const MAX_EXTENSION_HOOK_TIMEOUT_MS = 60_000;
export const MAX_EXTENSION_ID_LENGTH = 128;

export type ExtensionHookPhase = "before-tool" | "after-tool" | "event";

/** A tool descriptor intentionally omits the executable adapter and host closures. */
export interface ExtensionToolInfo {
  readonly name: string;
  readonly description: string;
  readonly effect: MoweToolEntry["metadata"]["effect"];
  readonly scope: MoweToolEntry["metadata"]["scope"];
  readonly requiresApproval: boolean;
}

/** Read-only input visible to a before-tool extension hook. */
export interface ExtensionToolCallContext {
  readonly runId: RunId;
  readonly laneId: LaneId;
  readonly operationId: string;
  readonly call: Readonly<Pick<ToolCall, "id" | "name" | "arguments">>;
  readonly tool: ExtensionToolInfo;
  readonly signal?: AbortSignal;
}

/** Read-only input visible to an after-tool extension hook. */
export interface ExtensionToolResultContext extends ExtensionToolCallContext {
  readonly result: Readonly<ToolResult>;
}

export type ExtensionBeforeToolResult =
  | void
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "transform"; readonly arguments: Record<string, unknown> };

export type ExtensionBeforeToolHandler = (
  context: ExtensionToolCallContext,
) => ExtensionBeforeToolResult | Promise<ExtensionBeforeToolResult>;

export type ExtensionAfterToolHandler = (
  context: ExtensionToolResultContext,
) => ToolResult | void | Promise<ToolResult | void>;

export interface ExtensionEventContext {
  readonly runId: RunId;
  readonly laneId: LaneId;
  readonly operationId?: string;
  readonly causationId?: EventId;
  readonly signal?: AbortSignal;
}

/**
 * Custom events and messages are observations for the host. They are never
 * appended to the model transcript by this seam; a host must explicitly map
 * an event to a durable fact or a boundary message if that is appropriate.
 */
export type ExtensionEvent =
  | {
      readonly type: "custom";
      readonly name: string;
      readonly payload: unknown;
    }
  | {
      readonly type: "message";
      readonly content: string;
      readonly display?: boolean;
      readonly details?: unknown;
    };

export type ExtensionEventHandler = (
  event: ExtensionEvent,
  context: ExtensionEventContext,
) => void | Promise<void>;

/**
 * Small, typed extension surface adapted from Pi's before/after tool hooks.
 * Extensions receive data-only snapshots and have no direct tool, Ledger,
 * filesystem, scheduler, or provider authority.
 */
export interface NausicaaExtension {
  readonly id: string;
  readonly beforeToolCall?: ExtensionBeforeToolHandler;
  readonly afterToolResult?: ExtensionAfterToolHandler;
  readonly onEvent?: ExtensionEventHandler;
}

export interface ExtensionHostOptions {
  readonly hookTimeoutMs?: number;
}

export interface ExtensionBeforeToolOutcome {
  readonly action: "allow" | "deny";
  readonly arguments: Record<string, unknown>;
  readonly reason?: string;
  readonly extensionId?: string;
}

export class ExtensionHookError extends Error {
  override readonly name = "ExtensionHookError";
  readonly extensionId: string;
  readonly phase: ExtensionHookPhase;
  readonly timedOut: boolean;

  constructor(
    extensionId: string,
    phase: ExtensionHookPhase,
    message: string,
    options: { readonly timedOut?: boolean } = {},
  ) {
    super(`Extension ${extensionId} ${phase} hook failed: ${message}`);
    this.extensionId = extensionId;
    this.phase = phase;
    this.timedOut = options.timedOut ?? false;
  }
}

/**
 * Immutable extension registry and hook runner. Registration order is
 * preserved, matching Pi's handler ordering while keeping one explicit owner
 * for extension execution.
 */
export class ExtensionHost {
  readonly #extensions: readonly NausicaaExtension[];
  readonly #hookTimeoutMs: number;

  constructor(
    extensions: readonly NausicaaExtension[] = [],
    options: ExtensionHostOptions = {},
  ) {
    this.#hookTimeoutMs = boundedHookTimeout(options.hookTimeoutMs);
    const ids = new Set<string>();
    const normalized: NausicaaExtension[] = [];
    for (const extension of extensions) {
      validateExtension(extension);
      if (ids.has(extension.id)) throw new TypeError(`Duplicate extension id: ${extension.id}`);
      ids.add(extension.id);
      normalized.push(Object.freeze({ ...extension }));
    }
    this.#extensions = Object.freeze(normalized);
  }

  get extensions(): readonly NausicaaExtension[] {
    return this.#extensions;
  }

  get hookTimeoutMs(): number {
    return this.#hookTimeoutMs;
  }

  /**
   * Execute before-tool hooks in registration order. Every argument
   * transformation is returned to the caller for schema re-validation; this
   * method never invokes a tool or grants an extension execution authority.
   */
  async runBeforeToolCall(context: ExtensionToolCallContext): Promise<ExtensionBeforeToolOutcome> {
    let arguments_ = cloneRecord(context.call.arguments);
    for (const extension of this.#extensions) {
      if (extension.beforeToolCall === undefined) continue;
      const result = await this.#invoke(
        extension,
        "before-tool",
        (signal) => extension.beforeToolCall!(toolCallContext(context, arguments_, signal)),
        context.signal,
      );
      if (result === undefined) continue;
      if (!isRecord(result)) {
        throw new ExtensionHookError(extension.id, "before-tool", "hook must return an allow, deny, or transform decision");
      }
      if (result.action === "allow") continue;
      if (result.action === "deny") {
        const reason = result.reason === undefined ? undefined : boundedReason(result.reason);
        return {
          action: "deny",
          arguments: cloneRecord(arguments_),
          extensionId: extension.id,
          ...(reason === undefined ? {} : { reason }),
        };
      }
      if (result.action !== "transform" || !isRecord(result.arguments)) {
        throw new ExtensionHookError(extension.id, "before-tool", "transform decisions require an arguments object");
      }
      arguments_ = cloneRecord(result.arguments);
    }
    return { action: "allow", arguments: arguments_ };
  }

  /**
   * Execute after-tool hooks in registration order. The caller remains
   * responsible for sanitizing, validating media, and applying output bounds
   * after this method returns.
   */
  async runAfterToolResult(context: ExtensionToolResultContext): Promise<ToolResult> {
    let result = cloneToolResult(context.result);
    for (const extension of this.#extensions) {
      if (extension.afterToolResult === undefined) continue;
      const replacement = await this.#invoke(
        extension,
        "after-tool",
        (signal) => extension.afterToolResult!(resultContext(context, result, signal)),
        context.signal,
      );
      if (replacement === undefined) continue;
      if (!isToolResult(replacement)) {
        throw new ExtensionHookError(extension.id, "after-tool", "hook must return a ToolResult or void");
      }
      result = cloneToolResult(replacement);
    }
    return result;
  }

  /** Dispatch an observation without allowing extension failure to affect the runtime. */
  async emit(event: ExtensionEvent, context: ExtensionEventContext): Promise<void> {
    for (const extension of this.#extensions) {
      if (extension.onEvent === undefined) continue;
      try {
        await this.#invoke(
          extension,
          "event",
          (signal) => extension.onEvent!(cloneEvent(event), cloneEventContext(context, signal)),
          context.signal,
        );
      } catch {
        // Event handlers are observational. Tool and model state cannot depend
        // on an extension's diagnostics or UI availability.
      }
    }
  }

  async #invoke<T>(
    extension: NausicaaExtension,
    phase: ExtensionHookPhase,
    invoke: (signal: AbortSignal) => T | Promise<T>,
    parentSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (parentSignal?.aborted === true) throw abortError(parentSignal);
    const timeoutController = new AbortController();
    const signal = parentSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([parentSignal, timeoutController.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve().then(() => invoke(signal));
      const abort = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          const reason = timeoutController.signal.aborted && !parentSignal?.aborted
            ? new ExtensionHookError(
                extension.id,
                phase,
                `exceeded ${this.#hookTimeoutMs}ms`,
                { timedOut: true },
              )
            : abortError(parentSignal ?? signal);
          reject(reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => timeoutController.abort(), this.#hookTimeoutMs);
        pending.then(
          () => signal.removeEventListener("abort", onAbort),
          () => signal.removeEventListener("abort", onAbort),
        );
      });
      return await Promise.race([pending, abort]);
    } catch (error: unknown) {
      if (error instanceof ExtensionHookError) throw error;
      if (parentSignal !== undefined && parentSignal.aborted) throw abortError(parentSignal);
      throw new ExtensionHookError(extension.id, phase, errorMessage(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function createExtensionHost(
  extensions: readonly NausicaaExtension[] = [],
  options: ExtensionHostOptions = {},
): ExtensionHost {
  return new ExtensionHost(extensions, options);
}

function validateExtension(extension: NausicaaExtension): void {
  if (extension === null || typeof extension !== "object") {
    throw new TypeError("Extension must be an object");
  }
  if (typeof extension.id !== "string"
    || extension.id.length === 0
    || extension.id.length > MAX_EXTENSION_ID_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(extension.id)) {
    throw new TypeError("Extension id must be an ASCII identifier up to 128 characters");
  }
  for (const [name, handler] of [
    ["beforeToolCall", extension.beforeToolCall],
    ["afterToolResult", extension.afterToolResult],
    ["onEvent", extension.onEvent],
  ] as const) {
    if (handler !== undefined && typeof handler !== "function") {
      throw new TypeError(`Extension ${name} must be a function`);
    }
  }
}

function boundedHookTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_EXTENSION_HOOK_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_EXTENSION_HOOK_TIMEOUT_MS) {
    throw new RangeError(`hookTimeoutMs must be an integer between 1 and ${MAX_EXTENSION_HOOK_TIMEOUT_MS}`);
  }
  return resolved;
}

function toolCallContext(
  context: ExtensionToolCallContext,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
): ExtensionToolCallContext {
  return Object.freeze({
    runId: context.runId,
    laneId: context.laneId,
    operationId: context.operationId,
    call: Object.freeze({
      id: context.call.id,
      name: context.call.name,
      arguments: deepFreeze(cloneRecord(arguments_)),
    }),
    tool: Object.freeze({ ...context.tool }),
    signal,
  });
}

function resultContext(
  context: ExtensionToolResultContext,
  result: ToolResult,
  signal: AbortSignal,
): ExtensionToolResultContext {
  return Object.freeze({
    ...toolCallContext(context, context.call.arguments, signal),
    result: deepFreeze(cloneToolResult(result)),
  });
}

function cloneEventContext(context: ExtensionEventContext, signal: AbortSignal): ExtensionEventContext {
  return Object.freeze({
    runId: context.runId,
    laneId: context.laneId,
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    signal,
  });
}

function cloneEvent(event: ExtensionEvent): ExtensionEvent {
  if (event.type === "custom") {
    return Object.freeze({
      type: "custom",
      name: event.name,
      payload: deepFreeze(structuredClone(event.payload)),
    });
  }
  return Object.freeze({
    type: "message",
    content: event.content,
    ...(event.display === undefined ? {} : { display: event.display }),
    ...(event.details === undefined ? {} : { details: deepFreeze(structuredClone(event.details)) }),
  });
}

function cloneToolResult(result: ToolResult): ToolResult {
  return {
    content: result.content,
    isError: result.isError,
    ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value)
    && typeof value.content === "string"
    && typeof value.isError === "boolean"
    && (value.images === undefined || Array.isArray(value.images));
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedReason(value: string): string {
  return value.slice(0, 1_024);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
