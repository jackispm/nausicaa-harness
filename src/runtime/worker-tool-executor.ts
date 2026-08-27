import type { A2AMessage, AppendEvent, Clock, ConversationMessage, EventType, LaneId, ToolCall } from "../domain/index.js";
import type { AgentTool, ToolResult } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { ContentAddressedStore } from "../store/index.js";
import {
  boundedRedactedText,
  persistedErrorText,
  redactSensitiveText,
} from "./redaction.js";
import { WorkerTaskExecutorError } from "./worker-task-errors.js";

const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";
const MAX_WORKER_TOOL_RESULT_BYTES = 256 * 1024;
const ALLOWED_WORKER_TOOLS = new Set([
  "read_file",
  "list_files",
  "grep",
  "find",
]);

type AppendWorkerEvent = <K extends EventType>(event: AppendEvent<K>) => Promise<void>;

export interface WorkerToolExecutorOptions {
  tools: readonly AgentTool[];
  store: ContentAddressedStore;
  runId: string;
  laneId: LaneId;
  workspace: string;
  clock: Clock;
  append: AppendWorkerEvent;
}

export interface WorkerToolExecutionRequest {
  taskId: string;
  turn: number;
  eventPrefix: string;
  call: ToolCall;
  signal: AbortSignal;
  correlationId: string;
  visibility: A2AMessage["visibility"];
  executionError?: string;
}

/** Executes only the fixed read-only Worker tool surface and records its lifecycle. */
export class WorkerToolExecutor {
  readonly definitions: AgentTool["definition"][];

  private readonly toolsByName: ReadonlyMap<string, AgentTool>;
  private readonly store: ContentAddressedStore;
  private readonly runId: string;
  private readonly laneId: LaneId;
  private readonly workspace: string;
  private readonly clock: Clock;
  private readonly append: AppendWorkerEvent;

  constructor(options: WorkerToolExecutorOptions) {
    const toolsByName = new Map<string, AgentTool>();
    for (const tool of options.tools) {
      const name = tool.definition.name;
      if (name.trim().length === 0) {
        throw new WorkerTaskExecutorError("Worker tool names must not be empty");
      }
      if (!ALLOWED_WORKER_TOOLS.has(name)) {
        throw new WorkerTaskExecutorError(`Worker tool is not an allowed read-only tool: ${name}`);
      }
      if (toolsByName.has(name)) {
        throw new WorkerTaskExecutorError(`Duplicate Worker tool definition: ${name}`);
      }
      toolsByName.set(name, tool);
    }
    this.definitions = options.tools.map((tool) => tool.definition);
    this.toolsByName = toolsByName;
    this.store = options.store;
    this.runId = options.runId;
    this.laneId = options.laneId;
    this.workspace = options.workspace;
    this.clock = options.clock;
    this.append = options.append;
  }

  async execute(request: WorkerToolExecutionRequest): Promise<{
    message: ConversationMessage;
    ref: Awaited<ReturnType<ContentAddressedStore["put"]>>;
  }> {
    throwIfAborted(request.signal);
    const call = request.call;
    const operationId = `op:${sha256(stableJson({
      runId: this.runId,
      laneId: this.laneId,
      taskId: request.taskId,
      turn: request.turn,
      toolCallId: call.id,
      toolName: call.name,
    }))}`;
    const argumentsRef = await this.store.put(
      stableJson(call.arguments),
      TOOL_ARGUMENTS_MEDIA_TYPE,
    );
    const toolPrefix = `${request.eventPrefix}:tool:${call.id}`;
    await this.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "tool.requested",
      payload: {
        operationId,
        toolCallId: call.id,
        name: call.name,
        argumentsRef,
      },
      correlationId: request.correlationId,
      idempotencyKey: `${toolPrefix}:requested`,
      visibility: request.visibility,
      occurredAt: this.clock.now().toISOString(),
    });

    let result: ToolResult;
    const tool = this.toolsByName.get(call.name);
    if (request.executionError !== undefined) {
      result = { content: request.executionError, isError: true };
    } else if (tool === undefined) {
      result = { content: `Unknown tool: ${call.name}`, isError: true };
    } else {
      try {
        result = await withAbort(tool.execute(call.arguments, {
          runId: this.runId,
          workspace: this.workspace,
          operationId,
          signal: request.signal,
        }), request.signal);
      } catch (error: unknown) {
        throwIfAborted(request.signal);
        result = { content: persistedErrorText(error), isError: true };
      }
    }
    throwIfAborted(request.signal);
    result = boundWorkerToolResult(result);
    const message: ConversationMessage = {
      role: "tool",
      content: result.content,
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError,
      createdAt: this.clock.now().toISOString(),
    };
    const resultRef = await this.store.put(stableJson(message), MESSAGE_MEDIA_TYPE);
    if (result.isError) {
      await this.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "tool.failed",
        payload: {
          operationId,
          toolCallId: call.id,
          name: call.name,
          error: boundedRedactedText(result.content, 1_024),
          resultRef,
        },
        correlationId: request.correlationId,
        idempotencyKey: `${toolPrefix}:failed`,
        visibility: request.visibility,
        occurredAt: this.clock.now().toISOString(),
      });
    } else {
      await this.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "tool.succeeded",
        payload: {
          operationId,
          toolCallId: call.id,
          name: call.name,
          resultRef,
        },
        correlationId: request.correlationId,
        idempotencyKey: `${toolPrefix}:succeeded`,
        visibility: request.visibility,
        occurredAt: this.clock.now().toISOString(),
      });
    }
    return { message, ref: resultRef };
  }
}

function boundWorkerToolResult(result: ToolResult): ToolResult {
  const redacted = redactSensitiveText(result.content);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= MAX_WORKER_TOOL_RESULT_BYTES) {
    return { content: redacted, isError: result.isError };
  }
  const content = `${new TextDecoder().decode(
    bytes.subarray(0, MAX_WORKER_TOOL_RESULT_BYTES),
  )}\n[TRUNCATED BY WORKER]`;
  return { content, isError: result.isError };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}
