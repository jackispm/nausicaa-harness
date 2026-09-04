import type {
  AgentTool,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolDefinition,
  ToolResult,
} from "../domain/ports.js";
import type { ConversationMessage, TokenUsage, ToolCall } from "../domain/types.js";

/** Default bound for a standalone kernel invocation. */
export const DEFAULT_L0_MAX_STEPS = 16;
/** Keep accidental provider/tool loops finite even when a caller omits a bound. */
export const MAX_L0_MAX_STEPS = 1_024;
/** Conservative upper bound for an optional cumulative model usage budget. */
export const MAX_L0_MODEL_TOKENS = 1_000_000_000;

export type L0ToolExecutionMode = "sequential" | "parallel";

/** Request fields are assembled by the host; messages and tools are kernel-owned. */
export type L0ModelRequest = Omit<ModelRequest, "messages" | "tools" | "signal">;

export interface L0AgentLoopInput {
  /** Materialized context at the start of this invocation. It is never persisted here. */
  readonly messages: readonly ConversationMessage[];
  readonly request: L0ModelRequest;
  /** Workspace is only passed to injected tools; it is not interpreted by L0. */
  readonly workspace?: string;
  readonly signal?: AbortSignal;
  /** Maximum number of model requests, including the initial request. */
  readonly maxSteps?: number;
  /** Optional cumulative input/output/cache token budget. */
  readonly maxModelTokens?: number;
}

export interface L0AgentLoopDeps {
  readonly model: ModelPort;
  readonly tools?: readonly AgentTool[];
  /** Default is parallel, matching Pi's independent tool-call behavior. */
  readonly toolExecution?: L0ToolExecutionMode;
  /** Best-effort observation; it cannot change kernel state or fail the loop. */
  readonly onEvent?: (event: L0AgentLoopEvent) => void;
  /** Raw provider stream events, useful for UI adapters and parity fixtures. */
  readonly onStreamEvent?: (event: ModelStreamEvent) => void;
}

export type L0AgentLoopEvent =
  | { type: "model.requested"; step: number; request: ModelRequest }
  | { type: "model.stream"; step: number; event: ModelStreamEvent }
  | { type: "assistant.message"; step: number; message: ConversationMessage }
  | { type: "tool.started"; step: number; call: ToolCall }
  | { type: "tool.completed"; step: number; call: ToolCall; message: ConversationMessage }
  | {
      type: "step.completed";
      step: number;
      response: ModelResponse;
      toolMessages: readonly ConversationMessage[];
    };

export interface L0AgentLoopResult {
  /** Only messages generated during this invocation; input context is excluded. */
  readonly messages: readonly ConversationMessage[];
  readonly finalText: string;
  readonly usage: TokenUsage;
  readonly steps: number;
  readonly completed: boolean;
  readonly aborted: boolean;
  readonly stopReason?: string;
  readonly finalMessage?: ConversationMessage;
}

/** Functional entrypoint for hosts that do not need to retain loop state. */
export async function runL0AgentLoop(
  input: L0AgentLoopInput,
  deps: L0AgentLoopDeps,
): Promise<L0AgentLoopResult> {
  return new L0AgentLoop(deps).run(input);
}

/** Raised when the provider stream violates the ModelPort completion contract. */
export class L0ProtocolError extends Error {
  override readonly name = "L0ProtocolError";
}

/**
 * Provider-neutral single-lane cognition mechanics.
 *
 * This class deliberately has no Ledger, store, filesystem, retry, permission,
 * compaction, or scheduler dependency. A host can persist the returned message
 * delta and wrap the model/tool ports with its own durable policy boundary.
 */
export class L0AgentLoop {
  private readonly model: ModelPort;
  private readonly tools: readonly AgentTool[];
  private readonly toolExecution: L0ToolExecutionMode;
  private readonly onEvent: L0AgentLoopDeps["onEvent"];
  private readonly onStreamEvent: L0AgentLoopDeps["onStreamEvent"];

  constructor(deps: L0AgentLoopDeps) {
    this.model = deps.model;
    const tools = [...(deps.tools ?? [])];
    const names = new Set<string>();
    for (const tool of tools) {
      const name = tool.definition.name.trim();
      if (name.length === 0) throw new Error("Tool names must not be empty");
      if (names.has(name)) throw new Error(`Duplicate tool: ${name}`);
      names.add(name);
    }
    this.tools = Object.freeze(tools);
    this.toolExecution = deps.toolExecution ?? "parallel";
    if (this.toolExecution !== "parallel" && this.toolExecution !== "sequential") {
      throw new Error("toolExecution must be parallel or sequential");
    }
    this.onEvent = deps.onEvent;
    this.onStreamEvent = deps.onStreamEvent;
  }

  async run(input: L0AgentLoopInput): Promise<L0AgentLoopResult> {
    validateInput(input);
    throwIfAborted(input.signal);

    const maxSteps = input.maxSteps ?? DEFAULT_L0_MAX_STEPS;
    const maxModelTokens = input.maxModelTokens;
    const context: ConversationMessage[] = input.messages.map(cloneMessage);
    const generated: ConversationMessage[] = [];
    let usage = emptyUsage();
    let finalText = "";
    let finalMessage: ConversationMessage | undefined;
    let stopReason: string | undefined;
    let steps = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      throwIfAborted(input.signal);
      if (maxModelTokens !== undefined && chargedTokens(usage) >= maxModelTokens) break;

      const request: ModelRequest = {
        ...input.request,
        messages: context.map(cloneMessage),
        tools: this.tools.map((tool) => cloneDefinition(tool.definition)),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      this.emit({ type: "model.requested", step, request: cloneRequest(request) });
      const response = await this.requestModel(request, step);
      throwIfAborted(input.signal);

      steps += 1;
      validateModelResponse(response);
      usage = addUsage(usage, response.usage);
      finalText = response.content;
      stopReason = response.stopReason;

      const assistantMessage: ConversationMessage = {
        role: "assistant",
        content: response.content,
        toolCalls: structuredClone(response.toolCalls),
        createdAt: new Date().toISOString(),
      };
      context.push(assistantMessage);
      generated.push(assistantMessage);
      finalMessage = assistantMessage;
      this.emit({
        type: "assistant.message",
        step,
        message: cloneMessage(assistantMessage),
      });

      if (response.stopReason === "aborted") {
        this.emit({ type: "step.completed", step, response: structuredClone(response), toolMessages: [] });
        return result(generated, finalText, usage, steps, false, true, stopReason, finalMessage);
      }

      const toolMessages = response.toolCalls.length === 0
        ? []
        : response.stopReason === "length"
          ? this.failTruncatedToolCalls(step, response.toolCalls)
          : await this.executeTools(input, step, response.toolCalls);
      context.push(...toolMessages);
      generated.push(...toolMessages);
      this.emit({
        type: "step.completed",
        step,
        response: structuredClone(response),
        toolMessages: toolMessages.map(cloneMessage),
      });

      if (response.toolCalls.length === 0) {
        return result(
          generated,
          finalText,
          usage,
          steps,
          response.stopReason === "stop",
          false,
          stopReason,
          finalMessage,
        );
      }
      if (maxModelTokens !== undefined && chargedTokens(usage) >= maxModelTokens) break;
    }

    return result(generated, finalText, usage, steps, false, false, stopReason, finalMessage);
  }

  private async requestModel(request: ModelRequest, step: number): Promise<ModelResponse> {
    throwIfAborted(request.signal);
    if (this.model.stream === undefined) {
      return raceAbort(this.model.complete(request), request.signal);
    }

    const stream = this.model.stream(request);
    const iterator = stream[Symbol.asyncIterator]();
    let response: ModelResponse | undefined;
    try {
      while (true) {
        const next = await raceAbort(iterator.next(), request.signal);
        if (next.done) break;
        const event = next.value;
        this.emit({ type: "model.stream", step, event: cloneStreamEvent(event) });
        try {
          // Keep observers from mutating the provider event consumed below.
          this.onStreamEvent?.(cloneStreamEvent(event));
        } catch {
          // Stream rendering is observational and cannot change cognition state.
        }
        if (event.type === "done") {
          response = event.response;
          break;
        }
        if (event.type === "error") throw event.error;
      }
    } catch (error: unknown) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // A broken iterator close cannot replace the provider failure.
      }
      throw error;
    }
    if (response === undefined) {
      throw new L0ProtocolError("Model stream ended without a final response");
    }
    return response;
  }

  private async executeTools(
    input: L0AgentLoopInput,
    step: number,
    calls: readonly ToolCall[],
  ): Promise<ConversationMessage[]> {
    if (this.toolExecution === "sequential") {
      const messages: ConversationMessage[] = [];
      for (const call of calls) {
        messages.push(await this.executeTool(input, step, call));
      }
      throwIfAborted(input.signal);
      return messages;
    }

    // Promise.all preserves source order in its returned array while each
    // tool starts immediately, so completion observation and model context
    // ordering remain separate contracts.
    const messages = await Promise.all(calls.map((call) => this.executeTool(input, step, call)));
    throwIfAborted(input.signal);
    return messages;
  }

  private failTruncatedToolCalls(
    step: number,
    calls: readonly ToolCall[],
  ): ConversationMessage[] {
    return calls.map((call) => {
      const message = toolMessage(
        call,
        `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
        true,
      );
      this.emit({
        type: "tool.completed",
        step,
        call: structuredClone(call),
        message: cloneMessage(message),
      });
      return message;
    });
  }

  private async executeTool(
    input: L0AgentLoopInput,
    step: number,
    call: ToolCall,
  ): Promise<ConversationMessage> {
    let message: ConversationMessage;
    const tool = this.tools.find((candidate) => candidate.definition.name === call.name);
    if (input.signal?.aborted === true) {
      message = toolMessage(call, "Operation aborted", true);
    } else if (tool === undefined) {
      message = toolMessage(call, `Tool ${call.name} not found`, true);
    } else {
      const validationError = validateArguments(tool.definition, call.arguments);
      if (validationError !== undefined) {
        message = toolMessage(call, validationError, true);
      } else if (call.name.length === 0) {
        message = toolMessage(call, "Tool call name must not be empty", true);
      } else {
        const operationId = `l0:${input.request.runId}:${input.request.laneId}:step:${step}:tool:${call.id}`;
        this.emit({ type: "tool.started", step, call: structuredClone(call) });
        try {
          const result = await tool.execute(call.arguments, {
            runId: input.request.runId,
            laneId: input.request.laneId,
            workspace: input.workspace ?? "",
            operationId,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          message = toolMessage(call, result.content, result.isError, result.images);
        } catch (error: unknown) {
          message = toolMessage(call, errorMessage(error), true);
        }
      }
    }
    this.emit({
      type: "tool.completed",
      step,
      call: structuredClone(call),
      message: cloneMessage(message),
    });
    return message;
  }

  private emit(event: L0AgentLoopEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Event observers are intentionally outside the kernel's state machine.
    }
  }
}

function result(
  messages: readonly ConversationMessage[],
  finalText: string,
  usage: TokenUsage,
  steps: number,
  completed: boolean,
  aborted: boolean,
  stopReason: string | undefined,
  finalMessage: ConversationMessage | undefined,
): L0AgentLoopResult {
  return {
    messages: Object.freeze(messages.map(cloneMessage)),
    finalText,
    usage,
    steps,
    completed,
    aborted,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(finalMessage === undefined ? {} : { finalMessage: cloneMessage(finalMessage) }),
  };
}

function toolMessage(
  call: ToolCall,
  content: string,
  isError: boolean,
  images?: ToolResult["images"],
): ConversationMessage {
  return {
    role: "tool",
    content,
    toolCallId: call.id,
    toolName: call.name,
    isError,
    ...(images === undefined ? {} : { images: structuredClone(images) }),
    createdAt: new Date().toISOString(),
  };
}

function validateInput(input: L0AgentLoopInput): void {
  if (input.request.runId.trim().length === 0) throw new Error("runId is required");
  if (input.request.laneId.trim().length === 0) throw new Error("laneId is required");
  if (input.request.sessionId.trim().length === 0) throw new Error("sessionId is required");
  if (input.request.model.trim().length === 0) throw new Error("model is required");
  if (!Number.isSafeInteger(input.request.maxOutputTokens) || input.request.maxOutputTokens < 1) {
    throw new Error("maxOutputTokens must be a positive integer");
  }
  const maxSteps = input.maxSteps ?? DEFAULT_L0_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_L0_MAX_STEPS) {
    throw new Error(`maxSteps must be an integer between 1 and ${MAX_L0_MAX_STEPS}`);
  }
  if (input.maxModelTokens !== undefined
    && (!Number.isSafeInteger(input.maxModelTokens)
      || input.maxModelTokens < 1
      || input.maxModelTokens > MAX_L0_MODEL_TOKENS)) {
    throw new Error(`maxModelTokens must be an integer between 1 and ${MAX_L0_MODEL_TOKENS}`);
  }
}

function validateToolCalls(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (call.id.trim().length === 0 || call.name.trim().length === 0) {
      throw new L0ProtocolError("Tool calls require non-empty id and name");
    }
    if (call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new L0ProtocolError(`Tool call arguments must be an object: ${call.id}`);
    }
    if (ids.has(call.id)) throw new L0ProtocolError(`Duplicate tool call id: ${call.id}`);
    ids.add(call.id);
  }
}

function validateModelResponse(response: ModelResponse): void {
  if (typeof response.content !== "string") {
    throw new L0ProtocolError("Model response content must be a string");
  }
  if (typeof response.stopReason !== "string" || response.stopReason.length === 0) {
    throw new L0ProtocolError("Model response stopReason must be a non-empty string");
  }
  if (!Array.isArray(response.toolCalls)) {
    throw new L0ProtocolError("Model response toolCalls must be an array");
  }
  if (response.usage === null || typeof response.usage !== "object") {
    throw new L0ProtocolError("Model response usage must be an object");
  }
  validateUsage(response.usage);
  validateToolCalls(response.toolCalls);
}

function validateArguments(definition: ToolDefinition, value: Record<string, unknown>): string | undefined {
  const schema = definition.parameters as unknown as SchemaNode;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return "Invalid tool schema";
  }
  if (schema.type !== undefined && schema.type !== "object") {
    return `Tool arguments must be object for ${definition.name}`;
  }
  const properties = schema.properties;
  if (properties !== undefined && (!isRecord(properties) || Array.isArray(properties))) {
    return "Invalid tool schema properties";
  }
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((key) => typeof key !== "string"))) {
    return "Invalid tool schema required list";
  }
  for (const key of (required as string[] | undefined) ?? []) {
    if (!Object.hasOwn(value, key)) return `arguments.${key} is required`;
  }
  if (schema.additionalProperties === false && isRecord(properties)) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) return `arguments.${key} is not allowed`;
    }
  }
  if (isRecord(properties)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateValue(value[key], propertySchema, `arguments.${key}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
}

function validateValue(value: unknown, schema: unknown, path: string): string | undefined {
  if (schema === true || schema === undefined) return undefined;
  if (schema === false) return `${path} is rejected by the declared schema`;
  if (!isRecord(schema)) return "Invalid tool schema";
  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
    return `${path} must equal the declared constant`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) {
    return `${path} must be one of the declared values`;
  }
  const type = schema.type;
  if (type === undefined) return undefined;
  const valid = type === "string" ? typeof value === "string"
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "boolean" ? typeof value === "boolean"
          : type === "null" ? value === null
            : type === "array" ? Array.isArray(value)
              : type === "object" ? isRecord(value) : false;
  if (!valid) return `${path} must be ${type}`;
  if (type === "array" && schema.items !== undefined && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(value[index], schema.items, `${path}[${index}]`);
      if (error !== undefined) return error;
    }
  }
  if (type === "object" && isRecord(value)) {
    const nested: ToolDefinition = {
      name: path,
      description: "",
      parameters: schema as unknown as ToolDefinition["parameters"],
    };
    return validateArguments(nested, value);
  }
  return undefined;
}

interface SchemaNode {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  enum?: unknown;
  const?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message);
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return structuredClone(definition);
}

function cloneRequest(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map(cloneMessage),
    tools: request.tools.map(cloneDefinition),
  };
}

function cloneStreamEvent(event: ModelStreamEvent): ModelStreamEvent {
  return structuredClone(event);
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0),
  };
}

function chargedTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function validateUsage(usage: TokenUsage): void {
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isFinite(usage[field]) || usage[field] < 0) {
      throw new L0ProtocolError(`Model usage.${field} must be a non-negative finite number`);
    }
  }
  if (usage.costUsd !== undefined
    && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new L0ProtocolError("Model usage.costUsd must be a non-negative finite number");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
