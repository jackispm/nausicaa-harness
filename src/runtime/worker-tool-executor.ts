import type { A2AMessage, AppendEvent, Clock, ConversationMessage, EventType, LaneId, ToolCall } from "../domain/index.js";
import type { AgentTool, ToolResult } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { MoweExecutor } from "../mowe/index.js";
import type { MoweCall, MoweCallResult } from "../mowe/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import {
  boundedRedactedText,
  redactSensitiveText,
} from "./redaction.js";
import { WorkerTaskExecutorError } from "./worker-task-errors.js";

const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";
/** Text remains compact; multimodal blocks use the separate image budget. */
export const MAX_WORKER_TOOL_RESULT_BYTES = 256 * 1024;
const ALLOWED_WORKER_TOOLS = new Set([
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

export interface WorkerToolBatchExecutionRequest extends Omit<WorkerToolExecutionRequest, "call"> {
  calls: readonly ToolCall[];
}

export interface WorkerToolExecutionResult {
  message: ConversationMessage;
  ref: Awaited<ReturnType<ContentAddressedStore["put"]>>;
}

/** Executes only the fixed read-only Worker tool surface and records its lifecycle. */
export class WorkerToolExecutor {
  readonly definitions: AgentTool["definition"][];

  private readonly store: ContentAddressedStore;
  private readonly runId: string;
  private readonly laneId: LaneId;
  private readonly workspace: string;
  private readonly clock: Clock;
  private readonly append: AppendWorkerEvent;
  private readonly mowe: MoweExecutor;

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
    this.store = options.store;
    this.runId = options.runId;
    this.laneId = options.laneId;
    this.workspace = options.workspace;
    this.clock = options.clock;
    this.mowe = new MoweExecutor({
      catalog: options.tools,
      sanitizeResult: boundWorkerToolResult,
    });
    this.append = options.append;
  }

  async execute(request: WorkerToolExecutionRequest): Promise<WorkerToolExecutionResult> {
    const results = await this.executeBatch({ ...request, calls: [request.call] });
    return results[0]!;
  }

  async executeBatch(request: WorkerToolBatchExecutionRequest): Promise<WorkerToolExecutionResult[]> {
    throwIfAborted(request.signal);
    const calls: MoweCall[] = [];
    for (const call of request.calls) {
      throwIfAborted(request.signal);
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
      await this.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "tool.requested",
        payload: { operationId, toolCallId: call.id, name: call.name, argumentsRef },
        correlationId: request.correlationId,
        idempotencyKey: `${request.eventPrefix}:tool:${call.id}:requested`,
        visibility: request.visibility,
        occurredAt: this.clock.now().toISOString(),
      });
      calls.push({
        ...structuredClone(call),
        operationId,
        ...(request.executionError === undefined
          ? {}
          : { forcedError: request.executionError }),
      });
    }
    const results: WorkerToolExecutionResult[] = new Array(calls.length);
    await this.mowe.execute({
      runId: this.runId,
      laneId: this.laneId,
      workspace: this.workspace,
      calls,
      allowedEffects: ["read"],
      approvalLifecycle: {
        requested: async (context, argumentsHash) => {
          await this.append({
            runId: this.runId,
            laneId: this.laneId,
            type: "approval.requested",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash,
            },
            correlationId: request.correlationId,
            idempotencyKey: `${request.eventPrefix}:tool:${context.call.id}:approval:requested`,
            visibility: request.visibility,
            occurredAt: this.clock.now().toISOString(),
          });
        },
        decided: async (context, decision) => {
          await this.append({
            runId: this.runId,
            laneId: this.laneId,
            type: "approval.decided",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              decision: decision.decision,
              ...(decision.reason === undefined ? {} : {
                reason: boundedRedactedText(decision.reason, 1_024),
              }),
            },
            correlationId: request.correlationId,
            idempotencyKey: `${request.eventPrefix}:tool:${context.call.id}:approval:decided`,
            visibility: request.visibility,
            occurredAt: this.clock.now().toISOString(),
          });
        },
      },
      toolLifecycle: {
        admitted: async (context) => {
          await this.append({
            runId: this.runId,
            laneId: this.laneId,
            type: "tool.admitted",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash: context.argumentsHash,
            },
            correlationId: request.correlationId,
            idempotencyKey: `${request.eventPrefix}:tool:${context.call.id}:admitted`,
            visibility: request.visibility,
            occurredAt: this.clock.now().toISOString(),
          });
        },
        started: async (context) => {
          await this.append({
            runId: this.runId,
            laneId: this.laneId,
            type: "tool.started",
            payload: {
              operationId: context.operationId,
              toolCallId: context.call.id,
              name: context.call.name,
              argumentsHash: context.argumentsHash,
            },
            correlationId: request.correlationId,
            idempotencyKey: `${request.eventPrefix}:tool:${context.call.id}:started`,
            visibility: request.visibility,
            occurredAt: this.clock.now().toISOString(),
          });
        },
      },
      onResult: async (result, index) => {
        results[index] = await this.recordResult(request, result);
      },
      signal: request.signal,
    });
    // Mowe drains the entire batch, including terminal persistence, before
    // cancellation escapes or the next model request sees source-ordered results.
    throwIfAborted(request.signal);
    return results;
  }

  private async recordResult(
    request: WorkerToolBatchExecutionRequest,
    completed: MoweCallResult,
  ): Promise<WorkerToolExecutionResult> {
    const result = boundWorkerToolResult(completed.result);
    const operationId = completed.operationId;
    const toolPrefix = `${request.eventPrefix}:tool:${completed.callId}`;
    const message: ConversationMessage = {
      role: "tool",
      content: result.content,
      toolCallId: completed.callId,
      toolName: completed.name,
      isError: result.isError,
      ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
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
          toolCallId: completed.callId,
          name: completed.name,
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
          toolCallId: completed.callId,
          name: completed.name,
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
    return {
      content: redacted,
      isError: result.isError,
      ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
    };
  }
  const marker = "\n[TRUNCATED BY WORKER]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefix = utf8Prefix(bytes, Math.max(0, MAX_WORKER_TOOL_RESULT_BYTES - markerBytes));
  const content = `${prefix.toString("utf8")}${marker}`;
  return {
    content,
    isError: result.isError,
    ...(result.images === undefined ? {} : { images: structuredClone(result.images) }),
  };
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}
