import type {
  ModelResponse,
  ModelStreamEvent,
  TokenUsage,
  ToolCall,
} from "../domain/index.js";
import { stableJson } from "../ledger/hash.js";

/** Validate an untrusted provider response before billing or persistence. */
export function validateModelResponse(value: unknown): asserts value is ModelResponse {
  if (!isRecord(value)) throw new Error("Model response must be an object");
  if (typeof value.content !== "string") throw new Error("Model response content must be a string");
  if (typeof value.stopReason !== "string" || value.stopReason.trim().length === 0) {
    throw new Error("Model response stopReason must be a non-empty string");
  }
  validateUsage(value.usage);
  if (!Array.isArray(value.toolCalls)) throw new Error("Model response toolCalls must be an array");
  const ids = new Set<string>();
  for (const call of value.toolCalls) {
    validateToolCall(call);
    if (ids.has(call.id)) throw new Error(`Duplicate tool call id: ${call.id}`);
    ids.add(call.id);
  }
}

/** Validate a provider stream envelope before the runtime consumes it. */
export function validateModelStreamEvent(value: unknown): asserts value is ModelStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Model stream event must have a type");
  }
  switch (value.type) {
    case "start":
    case "thinking-start":
    case "thinking-end":
      return;
    case "thinking-delta":
    case "text-delta":
      if (typeof value.delta !== "string") throw new Error(`Model stream ${value.type} requires a string delta`);
      return;
    case "done":
      validateModelResponse(value.response);
      return;
    case "error":
      if (!(value.error instanceof Error)) throw new Error("Model stream error must be an Error");
      return;
    default:
      throw new Error(`Unsupported model stream event: ${value.type}`);
  }
}

function validateUsage(value: unknown): asserts value is TokenUsage {
  if (!isRecord(value)) throw new Error("Model usage must be an object");
  let total = 0;
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
      throw new Error(`Model usage ${field} must be a non-negative integer`);
    }
    total += fieldValue;
  }
  if (!Number.isSafeInteger(total)) {
    throw new Error("Model usage total exceeds the safe integer range");
  }
  if (value.costUsd !== undefined
    && (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    throw new Error("Model usage costUsd must be non-negative");
  }
}

function validateToolCall(value: unknown): asserts value is ToolCall {
  if (!isRecord(value)) throw new Error("Tool calls must be objects");
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("Tool calls require a non-empty id");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error("Tool calls require a non-empty name");
  }
  if (!isRecord(value.arguments)) {
    throw new Error(`Tool call arguments must be an object: ${value.id}`);
  }
  try {
    // Match the cloning and serialization used by durable assistant messages.
    stableJson(structuredClone(value.arguments));
  } catch {
    throw new Error(`Tool call arguments must be JSON-serializable: ${value.id}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
